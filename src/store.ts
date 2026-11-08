import { URI, Utils } from "vscode-uri";
import {
  CreateCommentInput,
  CreateReplyInput,
  lineRange,
  RelayComment,
  ReviewComment,
  sameRange
} from "./model";

/**
 * One workspace folder's review: the core's API, reached through
 * `review-relay attach` (relay.ts) or, in tests, a stand-in.
 */
export interface ReviewBackend {
  /** The folder, as VS Code writes its URI. */
  readonly folderUri: string;
  request<T = any>(method: string, path: string, body?: unknown): Promise<T>;
  /** Every event of the review: "state" (read it again), "navigate". */
  onEvent(listener: (event: { name: string; data: unknown }) => void): { dispose(): void };
}

export interface RemoveCommentsResult {
  removed: number;
  remainingComments: number;
}

export interface CommentStoreChange {
  comments?: true;
  threadRanges?: true;
  overall?: true;
}

interface Folder {
  backend: ReviewBackend;
  comments: ReviewComment[];
  overall: string;
  reading?: Promise<void>;
  again: boolean;
  subscription: { dispose(): void };
}

/**
 * The review of the workspace's folders, as VS Code shows it: a mirror of
 * what the core's servers hold, read again on every change they
 * announce. Every write goes to the server, which validates and stores it
 * and tells every client, this one included.
 */
export class CommentStore {
  private folders: Folder[] = [];
  private comments: ReviewComment[] = [];
  private overall = "";
  private readonly listeners = new Set<(change: CommentStoreChange) => void>();
  private readonly navigateListeners = new Set<(target: { uri: string; line: number; endLine: number; commentId?: string }) => void>();
  // Threads whose move this window sent and the server has not echoed yet.
  private readonly moving = new Map<string, number>();

  list(): readonly ReviewComment[] { return this.comments; }
  getOverall(): string { return this.overall; }
  get hasFolders(): boolean { return this.folders.length > 0; }

  /** Mirrors a folder's review; the first folder holds the overall comment. */
  async addFolder(backend: ReviewBackend): Promise<{ dispose(): void }> {
    const folder: Folder = {
      backend, comments: [], overall: "", again: false,
      subscription: backend.onEvent(event => {
        if (event.name === "state") void this.read(folder).catch(() => undefined);
        if (event.name === "navigate") this.announceNavigate(folder, event.data);
      })
    };
    this.folders.push(folder);
    await this.read(folder);
    return {
      dispose: () => {
        folder.subscription.dispose();
        this.folders = this.folders.filter(candidate => candidate !== folder);
        this.publish();
      }
    };
  }

  onDidNavigate(listener: (target: { uri: string; line: number; endLine: number; commentId?: string }) => void): { dispose(): void } {
    this.navigateListeners.add(listener);
    return { dispose: () => this.navigateListeners.delete(listener) };
  }

  async add(input: CreateCommentInput): Promise<ReviewComment> {
    const folder = this.folderOfUri(input.uri);
    const response = await folder.backend.request<{ comment: RelayComment }>("POST", "/v1/comments", {
      path: relativePath(folder.backend.folderUri, input.uri)!,
      line: input.line,
      ...(input.endLine === undefined ? {} : { endLine: input.endLine }),
      body: input.body,
      ...(input.author ? { author: input.author } : {}),
      source: input.source ?? "agent"
    });
    await this.read(folder);
    return toReviewComment(folder.backend.folderUri, response.comment);
  }

  /** Replies to the thread and moves it to the reply's location. */
  async reply(commentId: string, input: CreateReplyInput): Promise<ReviewComment | undefined> {
    const folder = this.folderOfComment(commentId);
    if (!folder) return undefined;
    const path = relativePath(folder.backend.folderUri, input.uri);
    if (path === undefined) throw new Error("A thread cannot move to another workspace folder.");
    const response = await folder.backend.request<{ comment: RelayComment }>(
      "POST", `/v1/comments/${encodeURIComponent(commentId)}/replies`, {
        path, line: input.line,
        ...(input.endLine === undefined ? {} : { endLine: input.endLine }),
        body: input.body,
        ...(input.author ? { author: input.author } : {}),
        source: input.source ?? "agent"
      });
    await this.read(folder);
    return toReviewComment(folder.backend.folderUri, response.comment);
  }

  /** Moves a thread whose lines the editor moved; nothing else changes. */
  async setThreadRange(commentId: string, range: ReviewComment["range"]): Promise<boolean> {
    const rootId = this.rootId(commentId);
    const folder = rootId ? this.folderOfComment(rootId) : undefined;
    const root = rootId ? this.comments.find(comment => comment.id === rootId) : undefined;
    if (!folder || !root || sameRange(root.range, lineRange(range.start.line, range.end.line))) return false;
    this.moving.set(root.id, (this.moving.get(root.id) ?? 0) + 1);
    try {
      await folder.backend.request("PUT", `/v1/comments/${encodeURIComponent(root.id)}/location`, {
        path: relativePath(folder.backend.folderUri, root.uri)!,
        line: range.start.line,
        endLine: range.end.line
      });
      await this.read(folder);
    } finally {
      const left = (this.moving.get(root.id) ?? 1) - 1;
      if (left > 0) this.moving.set(root.id, left);
      else this.moving.delete(root.id);
    }
    return true;
  }

  /** Whether a move of this thread from here is still on its way. */
  isMoving(rootId: string): boolean { return this.moving.has(rootId); }

  async setResolved(id: string, resolved: boolean): Promise<ReviewComment | undefined> {
    const folder = this.folderOfComment(id);
    if (!folder) return undefined;
    const response = await folder.backend.request<{ comment: RelayComment }>(
      "PUT", `/v1/comments/${encodeURIComponent(id)}/resolved`, { resolved });
    await this.read(folder);
    return toReviewComment(folder.backend.folderUri, response.comment);
  }

  rootId(id: string): string | undefined {
    const comment = this.comments.find(candidate => candidate.id === id);
    return comment?.parentId ?? comment?.id;
  }

  thread(rootId: string): readonly ReviewComment[] {
    return this.comments.filter(comment => comment.id === rootId || comment.parentId === rootId);
  }

  async remove(id: string): Promise<RemoveCommentsResult> {
    const folder = this.folderOfComment(id);
    if (!folder) return { removed: 0, remainingComments: this.comments.length };
    const before = this.comments.length;
    await folder.backend.request("DELETE", `/v1/comments/${encodeURIComponent(id)}`);
    await this.read(folder);
    return { removed: before - this.comments.length, remainingComments: this.comments.length };
  }

  async update(id: string, body: string): Promise<boolean> {
    const folder = this.folderOfComment(id);
    if (!folder) return false;
    await folder.backend.request("PATCH", `/v1/comments/${encodeURIComponent(id)}`, { body });
    await this.read(folder);
    return true;
  }

  async clear(): Promise<RemoveCommentsResult> {
    const removed = this.comments.length;
    await Promise.all(this.folders.map(async folder => {
      await folder.backend.request("DELETE", "/v1/comments");
      await this.read(folder);
    }));
    return { removed, remainingComments: this.comments.length };
  }

  async setOverall(overall: string): Promise<void> {
    const folder = this.folders[0];
    if (!folder) throw new Error("Open a folder to write an overall comment.");
    if (overall === folder.overall) return;
    await folder.backend.request("PUT", "/v1/overall", { overall });
    await this.read(folder);
  }

  /** Every comment, the overall comment and the reviewed marks. */
  async clearReview(): Promise<void> {
    await Promise.all(this.folders.map(async folder => {
      await folder.backend.request("DELETE", "/v1/review");
      await this.read(folder);
    }));
  }

  onDidChange(listener: (change: CommentStoreChange) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** Reads a folder's review again; reads asked for meanwhile are one more. */
  private read(folder: Folder): Promise<void> {
    if (folder.reading) {
      folder.again = true;
      return folder.reading;
    }
    folder.reading = (async () => {
      try {
        do {
          folder.again = false;
          const state = await folder.backend.request<{ overall: string; comments: RelayComment[] }>("GET", "/v1/comments");
          folder.comments = state.comments.map(comment => toReviewComment(folder.backend.folderUri, comment));
          folder.overall = state.overall;
          this.publish();
        } while (folder.again);
      } finally {
        folder.reading = undefined;
      }
    })();
    return folder.reading;
  }

  private publish(): void {
    const comments = this.folders.flatMap(folder => folder.comments);
    const overall = this.folders[0]?.overall ?? "";
    const change: CommentStoreChange = {};
    const before = new Map(this.comments.map(comment => [comment.id, comment]));
    // Keep the objects that did not change, so views can compare by identity.
    const merged = comments.map(comment => {
      const previous = before.get(comment.id);
      return previous && sameComment(previous, comment) ? previous : comment;
    });
    if (merged.length !== this.comments.length || merged.some((comment, index) => comment !== this.comments[index])) {
      const contentChanged = merged.length !== this.comments.length || merged.some(comment => {
        const previous = before.get(comment.id);
        return !previous || !sameComment(previous, comment, false);
      });
      if (contentChanged) change.comments = true;
      change.threadRanges = true;
    }
    if (overall !== this.overall) change.overall = true;
    this.comments = merged;
    this.overall = overall;
    if (Object.keys(change).length > 0) this.listeners.forEach(listener => listener(change));
  }

  private announceNavigate(folder: Folder, data: unknown): void {
    if (!data || typeof data !== "object") return;
    const target = data as { path?: unknown; line?: unknown; endLine?: unknown; commentId?: unknown };
    if (typeof target.path !== "string" || typeof target.line !== "number") return;
    const endLine = typeof target.endLine === "number" ? target.endLine : target.line;
    const uri = absoluteUri(folder.backend.folderUri, target.path);
    const commentId = typeof target.commentId === "string" ? target.commentId : undefined;
    this.navigateListeners.forEach(listener => listener({ uri, line: target.line as number, endLine, commentId }));
  }

  private folderOfUri(uri: string): Folder {
    const folder = this.folders.find(candidate => relativePath(candidate.backend.folderUri, uri) !== undefined);
    if (!folder) throw new Error("Review Relay reviews the files of the workspace's folders; this file is in none.");
    return folder;
  }

  private folderOfComment(id: string): Folder | undefined {
    return this.folders.find(folder => folder.comments.some(comment => comment.id === id));
  }
}

function sameComment(left: ReviewComment, right: ReviewComment, withRange = true): boolean {
  return left.id === right.id && left.parentId === right.parentId && left.uri === right.uri
    && left.body === right.body && left.author === right.author && left.source === right.source
    && left.createdAt === right.createdAt && left.resolved === right.resolved
    && (!withRange || sameRange(left.range, right.range));
}

export function toReviewComment(folderUri: string, comment: RelayComment): ReviewComment {
  return {
    id: comment.id,
    ...(comment.parentId ? { parentId: comment.parentId } : {}),
    uri: absoluteUri(folderUri, comment.path),
    range: lineRange(comment.line, comment.endLine),
    body: comment.body,
    author: comment.author,
    source: comment.source,
    createdAt: comment.createdAt,
    ...(comment.resolved ? { resolved: true } : {})
  };
}

/** The document URI of a workspace-relative path, as VS Code writes it. */
export function absoluteUri(folderUri: string, path: string): string {
  return Utils.joinPath(URI.parse(folderUri), ...path.split("/")).toString();
}

/** The workspace-relative path of a document URI, if it is in the folder. */
export function relativePath(folderUri: string, uri: string): string | undefined {
  const folder = URI.parse(folderUri);
  const document = URI.parse(uri);
  if (folder.scheme !== document.scheme || folder.authority !== document.authority) return undefined;
  const base = folder.path.replace(/\/+$/, "");
  if (!document.path.startsWith(`${base}/`)) return undefined;
  const path = document.path.slice(base.length + 1);
  return path === "" ? undefined : path;
}
