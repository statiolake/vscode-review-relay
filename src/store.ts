import { randomUUID } from "node:crypto";
import {
  CreateCommentInput,
  CreateReplyInput,
  ReviewComment,
  ReviewRelayState,
  validateCommentBody,
  validateCommentId,
  validateCommentRange,
  validateCreateComment,
  validateCreateReply,
  validateOverall,
  validateReviewRelayState,
  validateShowAgentLastOnly,
  sameRange
} from "./model";

export interface CommentPersistence {
  load(): unknown;
  save(state: ReviewRelayState): PromiseLike<void>;
}

export interface RemoveCommentsResult {
  removed: number;
  remainingComments: number;
}

export interface CommentStoreChange {
  comments?: true;
  threadRanges?: true;
  overall?: true;
  showAgentLastOnly?: true;
}

export class CommentStore {
  private state: ReviewRelayState;
  private readonly listeners = new Set<(change: CommentStoreChange) => void>();

  constructor(private readonly persistence: CommentPersistence) {
    this.state = validateReviewRelayState(persistence.load());
  }

  list(): readonly ReviewComment[] { return this.state.comments; }
  getOverall(): string { return this.state.overall; }
  showsAgentLastOnly(): boolean { return this.state.showAgentLastOnly; }

  threadRoots(): readonly ReviewComment[] {
    return this.state.comments.filter(comment => !comment.parentId);
  }

  visibleThreadRoots(): readonly ReviewComment[] {
    const roots = this.threadRoots();
    return this.state.showAgentLastOnly
      ? roots.filter(root => this.lastComment(root.id)?.source === "agent")
      : roots;
  }

  async add(input: CreateCommentInput): Promise<ReviewComment> {
    input = validateCreateComment(input);
    const comment: ReviewComment = {
      id: randomUUID(),
      uri: input.uri,
      range: {
        start: { line: input.line, character: 0 },
        end: { line: input.endLine ?? input.line, character: 0 }
      },
      body: input.body.trim(),
      author: input.author?.trim() || (input.source === "human" ? "Human" : "AI"),
      source: input.source ?? "agent",
      createdAt: new Date().toISOString()
    };
    this.state = { ...this.state, comments: [...this.state.comments, comment] };
    await this.commit({ comments: true });
    return comment;
  }

  async reply(commentId: string, input: CreateReplyInput): Promise<ReviewComment | undefined> {
    commentId = validateCommentId(commentId);
    input = validateCreateReply(input);
    const rootId = this.rootId(commentId);
    const root = rootId ? this.state.comments.find(comment => comment.id === rootId) : undefined;
    if (!root) return undefined;
    const range: ReviewComment["range"] = {
      start: { line: input.line, character: 0 },
      end: { line: input.endLine ?? input.line, character: 0 }
    };
    const thread = new Set(this.thread(root.id).map(comment => comment.id));
    const comment: ReviewComment = {
      id: randomUUID(),
      parentId: root.id,
      uri: root.uri,
      range,
      body: input.body.trim(),
      author: input.author?.trim() || (input.source === "human" ? "Human" : "AI"),
      source: input.source ?? "agent",
      createdAt: new Date().toISOString()
    };
    this.state = {
      ...this.state,
      comments: [
        ...this.state.comments.map(item => thread.has(item.id) ? { ...item, range } : item),
        comment
      ]
    };
    await this.commit({ comments: true, threadRanges: true });
    return comment;
  }

  async setThreadRange(commentId: string, range: ReviewComment["range"]): Promise<boolean> {
    commentId = validateCommentId(commentId);
    range = validateCommentRange(range);
    const rootId = this.rootId(commentId);
    if (!rootId) return false;
    const thread = this.thread(rootId);
    if (thread.length === 0 || thread.every(comment => sameRange(comment.range, range))) return false;
    const threadIds = new Set(thread.map(comment => comment.id));
    this.state = {
      ...this.state,
      comments: this.state.comments.map(comment =>
        threadIds.has(comment.id) ? { ...comment, range } : comment
      )
    };
    await this.commit({ threadRanges: true });
    return true;
  }

  rootId(id: string): string | undefined {
    const comment = this.state.comments.find(comment => comment.id === id);
    return comment?.parentId ?? comment?.id;
  }

  thread(rootId: string): readonly ReviewComment[] {
    return this.state.comments.filter(comment => comment.id === rootId || comment.parentId === rootId);
  }

  lastComment(rootId: string): ReviewComment | undefined {
    return this.thread(rootId).at(-1);
  }

  async remove(id: string): Promise<RemoveCommentsResult> {
    return this.removeMany([validateCommentId(id)]);
  }

  async removeMany(ids: readonly string[]): Promise<RemoveCommentsResult> {
    const removedIds = new Set(ids.map(validateCommentId));
    const next = this.state.comments.filter(comment =>
      !removedIds.has(comment.id) && (!comment.parentId || !removedIds.has(comment.parentId))
    );
    const removed = this.state.comments.length - next.length;
    if (removed === 0) return { removed: 0, remainingComments: this.state.comments.length };
    this.state = { ...this.state, comments: next };
    await this.commit({ comments: true });
    return { removed, remainingComments: next.length };
  }

  async update(id: string, body: string): Promise<boolean> {
    id = validateCommentId(id);
    const trimmed = validateCommentBody(body);
    const index = this.state.comments.findIndex(comment => comment.id === id);
    if (index < 0) return false;
    this.state = {
      ...this.state,
      comments: this.state.comments.map((comment, commentIndex) =>
        commentIndex === index ? { ...comment, body: trimmed } : comment
      )
    };
    await this.commit({ comments: true });
    return true;
  }

  async clear(): Promise<RemoveCommentsResult> {
    const removed = this.state.comments.length;
    if (removed === 0) return { removed: 0, remainingComments: 0 };
    this.state = { ...this.state, comments: [] };
    await this.commit({ comments: true });
    return { removed, remainingComments: 0 };
  }

  async setOverall(overall: string): Promise<void> {
    overall = validateOverall(overall);
    if (overall === this.state.overall) return;
    this.state = { ...this.state, overall };
    await this.commit({ overall: true });
  }

  async setShowAgentLastOnly(showAgentLastOnly: boolean): Promise<void> {
    showAgentLastOnly = validateShowAgentLastOnly(showAgentLastOnly);
    if (showAgentLastOnly === this.state.showAgentLastOnly) return;
    this.state = { ...this.state, showAgentLastOnly };
    await this.commit({ showAgentLastOnly: true });
  }

  async clearReview(): Promise<void> {
    if (this.state.comments.length === 0 && this.state.overall.length === 0) return;
    const hadComments = this.state.comments.length > 0;
    const hadOverall = this.state.overall.length > 0;
    this.state = { ...this.state, comments: [], overall: "" };
    await this.commit({
      ...(hadComments ? { comments: true } : {}),
      ...(hadOverall ? { overall: true } : {})
    });
  }

  onDidChange(listener: (change: CommentStoreChange) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private async commit(change: CommentStoreChange): Promise<void> {
    this.state = validateReviewRelayState(this.state);
    await this.persistence.save(this.state);
    this.listeners.forEach(listener => listener(change));
  }
}
