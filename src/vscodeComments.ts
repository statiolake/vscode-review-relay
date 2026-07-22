import * as vscode from "vscode";
import { CommentStore } from "./store";

type ThreadWithId = vscode.CommentThread & { reviewRelayId?: string };
type CommentWithId = vscode.Comment & { reviewRelayId: string; savedBody: string };

export class VsCodeComments implements vscode.Disposable {
  private readonly controller = vscode.comments.createCommentController("review-relay", "Review Relay");
  private readonly threads = new Map<string, vscode.CommentThread>();
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly store: CommentStore) {
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: document => document.lineCount === 0 ? [] : [
        new vscode.Range(0, 0, document.lineCount - 1, document.lineAt(document.lineCount - 1).text.length)
      ]
    };
    this.subscriptions.push(store.onDidChange(() => this.render()));
    this.render();
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
      await this.store.add({
        uri: thread.uri.toString(), line: thread.range.start.line, endLine: thread.range.end.line,
        body: text, author: "Human", source: "human"
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
    const thread = this.threads.get(comment.reviewRelayId);
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
    await this.store.update(comment.reviewRelayId, body);
  }

  cancelEdit(comment: CommentWithId): void {
    const thread = this.threads.get(comment.reviewRelayId);
    if (!thread) return;
    const markdown = new vscode.MarkdownString(comment.savedBody);
    markdown.isTrusted = false;
    comment.body = markdown;
    comment.mode = vscode.CommentMode.Preview;
    comment.contextValue = "preview";
    thread.comments = [...thread.comments];
  }

  async remove(comment: CommentWithId): Promise<void> {
    await this.store.remove(comment.reviewRelayId);
  }

  private render(): void {
    const remaining = new Set(this.threads.keys());
    for (const comment of this.store.list()) {
      remaining.delete(comment.id);
      const markdown = new vscode.MarkdownString(comment.body);
      markdown.isTrusted = false;
      const rendered: CommentWithId = {
        body: markdown,
        author: { name: comment.author },
        mode: vscode.CommentMode.Preview,
        contextValue: "preview",
        reviewRelayId: comment.id,
        savedBody: comment.body
      };
      const range = new vscode.Range(
        comment.range.start.line, comment.range.start.character,
        comment.range.end.line, comment.range.end.character
      );
      const existing = this.threads.get(comment.id) as ThreadWithId | undefined;
      if (existing) {
        existing.comments = [rendered];
        existing.range = range;
      } else {
        const thread = this.controller.createCommentThread(vscode.Uri.parse(comment.uri), range, [rendered]) as ThreadWithId;
        thread.reviewRelayId = comment.id;
        thread.contextValue = "review-relay";
        thread.canReply = false;
        this.threads.set(comment.id, thread);
      }
    }
    for (const id of remaining) {
      this.threads.get(id)?.dispose();
      this.threads.delete(id);
    }
  }

  dispose(): void {
    this.subscriptions.forEach(subscription => subscription.dispose());
    this.threads.forEach(thread => thread.dispose());
    this.controller.dispose();
  }
}
