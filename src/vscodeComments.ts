import * as vscode from "vscode";
import { ReviewComment } from "./model";
import { CommentStore } from "./store";

type ThreadWithId = vscode.CommentThread & { reviewRelayId?: string };
type CommentWithId = vscode.Comment & { reviewRelayId: string; savedBody: string };

export class VsCodeComments implements vscode.Disposable {
  private readonly controller = vscode.comments.createCommentController("review-relay", "Review Relay");
  private readonly threads = new Map<string, vscode.CommentThread>();
  private readonly threadModels = new Map<string, readonly ReviewComment[]>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private rangeSync = Promise.resolve();

  constructor(private readonly store: CommentStore) {
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: document => document.lineCount === 0 ? [] : [
        new vscode.Range(0, 0, document.lineCount - 1, document.lineAt(document.lineCount - 1).text.length)
      ]
    };
    this.subscriptions.push(
      store.onDidChange(change => {
        if (change.comments) this.render(change.threadRanges === true);
      }),
      vscode.workspace.onDidChangeTextDocument(event => this.queueRangeSync(event.document.uri))
    );
    this.render(true);
  }

  async addAtSelection(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const body = await vscode.window.showInputBox({ prompt: "Review comment", ignoreFocusOut: true });
    if (!body?.trim()) return;
    await this.store.add({
      uri: editor.document.uri.toString(),
      line: editor.selection.start.line,
      endLine: editor.selection.end.line,
      body,
      author: "Human",
      source: "human"
    });
  }

  async submit(reply: vscode.CommentReply): Promise<void> {
    const thread = reply.thread as ThreadWithId;
    const text = reply.text.trim();
    if (!text || !thread.range) return;
    if (thread.reviewRelayId) {
      await this.store.reply(thread.reviewRelayId, {
        line: thread.range.start.line,
        endLine: thread.range.end.line,
        body: text,
        author: "Human",
        source: "human"
      });
    } else {
      await this.store.add({
        uri: thread.uri.toString(), line: thread.range.start.line, endLine: thread.range.end.line,
        body: text, author: "Human", source: "human"
      });
      thread.dispose();
    }
  }

  edit(comment: CommentWithId): void {
    const rootId = this.store.rootId(comment.reviewRelayId);
    const thread = rootId ? this.threads.get(rootId) : undefined;
    if (!thread) return;
    comment.savedBody = typeof comment.body === "string" ? comment.body : comment.body.value;
    comment.mode = vscode.CommentMode.Editing;
    comment.contextValue = "editing";
    thread.comments = [...thread.comments];
  }

  async save(comment: CommentWithId): Promise<void> {
    const body = typeof comment.body === "string" ? comment.body : comment.body.value;
    if (!body.trim()) {
      void vscode.window.showWarningMessage("A comment cannot be empty.");
      return;
    }
    if (await this.store.update(comment.reviewRelayId, body)) {
      this.finishEditing(comment, body);
    }
  }

  cancelEdit(comment: CommentWithId): void {
    const rootId = this.store.rootId(comment.reviewRelayId);
    const thread = rootId ? this.threads.get(rootId) : undefined;
    if (!thread) return;
    const markdown = new vscode.MarkdownString(comment.savedBody);
    markdown.isTrusted = false;
    comment.body = markdown;
    comment.mode = vscode.CommentMode.Preview;
    comment.contextValue = "preview";
    thread.comments = [...thread.comments];
    this.render();
  }

  async remove(comment: CommentWithId): Promise<void> {
    await this.store.remove(comment.reviewRelayId);
  }

  expandThread(commentId: string): void {
    const rootId = this.store.rootId(commentId);
    const thread = rootId ? this.threads.get(rootId) : undefined;
    if (thread) thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  }

  currentRange(commentId: string): ReviewComment["range"] | undefined {
    const rootId = this.store.rootId(commentId);
    const range = rootId ? this.threads.get(rootId)?.range : undefined;
    return range ? toReviewRange(range) : undefined;
  }

  private queueRangeSync(uri: vscode.Uri): void {
    this.rangeSync = this.rangeSync
      .catch(() => undefined)
      .then(() => this.syncDocumentRanges(uri));
    void this.rangeSync.catch(error => {
      console.error("Review Relay could not synchronize comment ranges.", error);
    });
  }

  private async syncDocumentRanges(uri: vscode.Uri): Promise<void> {
    const uriString = uri.toString();
    for (const [commentId, thread] of this.threads) {
      if (thread.uri.toString() !== uriString || !thread.range) continue;
      await this.store.setThreadRange(commentId, toReviewRange(thread.range));
    }
  }

  private render(updateRanges = false): void {
    const remaining = new Set(this.threads.keys());
    for (const root of this.store.list().filter(comment => !comment.parentId)) {
      remaining.delete(root.id);
      const comments = this.store.thread(root.id);
      const range = new vscode.Range(
        root.range.start.line, root.range.start.character,
        root.range.end.line, root.range.end.character
      );
      const existing = this.threads.get(root.id) as ThreadWithId | undefined;
      if (existing) {
        if (!sameComments(this.threadModels.get(root.id), comments)) {
          if (updateRanges) existing.range = range;
          if (existing.comments.some(comment => comment.mode === vscode.CommentMode.Editing)) continue;
          existing.comments = comments.map(comment => this.renderComment(comment));
          this.threadModels.set(root.id, comments);
        } else if (updateRanges) {
          existing.range = range;
        }
      } else {
        const thread = this.controller.createCommentThread(
          vscode.Uri.parse(root.uri),
          range,
          comments.map(comment => this.renderComment(comment))
        ) as ThreadWithId;
        thread.reviewRelayId = root.id;
        thread.contextValue = "review-relay";
        thread.canReply = true;
        this.threads.set(root.id, thread);
        this.threadModels.set(root.id, comments);
      }
    }
    for (const id of remaining) {
      this.threads.get(id)?.dispose();
      this.threads.delete(id);
      this.threadModels.delete(id);
    }
  }

  private renderComment(comment: ReturnType<CommentStore["list"]>[number]): CommentWithId {
    const markdown = new vscode.MarkdownString(comment.body);
    markdown.isTrusted = false;
    return {
      body: markdown,
      author: { name: comment.author },
      mode: vscode.CommentMode.Preview,
      contextValue: "preview",
      reviewRelayId: comment.id,
      savedBody: comment.body
    };
  }

  private finishEditing(comment: CommentWithId, body: string): void {
    const rootId = this.store.rootId(comment.reviewRelayId);
    const thread = rootId ? this.threads.get(rootId) : undefined;
    if (!thread) return;
    const markdown = new vscode.MarkdownString(body.trim());
    markdown.isTrusted = false;
    comment.body = markdown;
    comment.savedBody = body.trim();
    comment.mode = vscode.CommentMode.Preview;
    comment.contextValue = "preview";
    thread.comments = [...thread.comments];
    this.render();
  }

  dispose(): void {
    this.subscriptions.forEach(subscription => subscription.dispose());
    this.threads.forEach(thread => thread.dispose());
    this.controller.dispose();
  }
}

function toReviewRange(range: vscode.Range): ReviewComment["range"] {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character }
  };
}

function sameComments(
  previous: readonly ReviewComment[] | undefined,
  current: readonly ReviewComment[]
): boolean {
  return previous?.length === current.length && current.every((comment, index) => comment === previous[index]);
}
