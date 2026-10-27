import * as vscode from "vscode";
import { NumberedChoice, numberComments, numberThreads, threadsAtLine, lineLabel } from "./cursorThreads";
import { ReviewComment } from "./model";
import { CommentStore } from "./store";
import { VsCodeComments } from "./vscodeComments";

export const CURSOR_ON_THREAD_CONTEXT = "reviewRelay.cursorOnThread";

/**
 * Keyboard counterparts of the comment-widget actions. Each acts on the
 * thread(s) covering the active editor's cursor line; when several do, a
 * numbered quick pick chooses one, like the standalone viewer.
 */
export class CursorCommands implements vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[] = [];
  private cursorOnThread: boolean | undefined;

  constructor(private readonly store: CommentStore, private readonly comments: VsCodeComments) {
    this.subscriptions.push(
      vscode.window.onDidChangeTextEditorSelection(() => this.updateContext()),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateContext()),
      store.onDidChange(change => {
        if (change.comments || change.threadRanges) this.updateContext();
      })
    );
    this.updateContext();
  }

  async reply(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const root = await this.chooseThread("Reply to");
    if (editor && root) await this.comments.focusReply(root.id, editor);
  }

  async edit(): Promise<void> {
    const comment = await this.chooseComment("Edit");
    if (comment) this.comments.editById(comment.id);
  }

  async deleteComment(): Promise<void> {
    const comment = await this.chooseComment("Delete");
    if (!comment) return;
    const size = this.store.thread(comment.parentId ?? comment.id).length;
    const message = !comment.parentId && size > 1
      ? `Delete the first comment? It starts the thread, so all ${size} comments go with it.`
      : `Delete this comment by ${comment.author}?`;
    if (await confirmDelete(message)) await this.store.remove(comment.id);
  }

  async deleteThread(): Promise<void> {
    const root = await this.chooseThread("Delete");
    if (!root) return;
    const size = this.store.thread(root.id).length;
    const message = `Delete the thread on ${lineLabel(root)} (${size} comment${size === 1 ? "" : "s"})?`;
    if (await confirmDelete(message)) await this.store.remove(root.id);
  }

  async toggleThread(): Promise<void> {
    const root = await this.chooseThread("Show or hide");
    if (root) this.comments.toggleThread(root.id);
  }

  async toggleResolved(): Promise<void> {
    const roots = this.threadsAtCursor();
    const verb = roots.some(root => !root.resolved) ? "Resolve or reopen" : "Reopen";
    const root = await this.chooseThread(verb, roots);
    if (root) await this.setResolved(root.id, !root.resolved);
  }

  /** Resolves or reopens a thread; a resolved thread also folds away. */
  async setResolved(commentId: string, resolved: boolean): Promise<void> {
    const root = await this.store.setResolved(commentId, resolved);
    if (root?.resolved) this.comments.collapseThread(root.id);
  }

  private threadsAtCursor(): ReviewComment[] {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return [];
    return threadsAtLine(this.store.list(), editor.document.uri.toString(), editor.selection.active.line);
  }

  private async chooseThread(verb: string, roots = this.threadsAtCursor()): Promise<ReviewComment | undefined> {
    return this.choose(numberThreads(roots, id => this.store.thread(id)), `${verb} which thread?`);
  }

  private async chooseComment(verb: string): Promise<ReviewComment | undefined> {
    const root = await this.chooseThread(verb);
    if (!root) return undefined;
    return this.choose(numberComments(this.store.thread(root.id)), `${verb} which comment?`);
  }

  private async choose(choices: NumberedChoice<ReviewComment>[], placeHolder: string): Promise<ReviewComment | undefined> {
    if (choices.length === 0) {
      void vscode.window.showInformationMessage("Review Relay: no thread on this line.");
      return undefined;
    }
    if (choices.length === 1) return choices[0].value;
    return (await vscode.window.showQuickPick(choices, { placeHolder, matchOnDescription: true }))?.value;
  }

  private updateContext(): void {
    const value = this.threadsAtCursor().length > 0;
    if (value === this.cursorOnThread) return;
    this.cursorOnThread = value;
    void vscode.commands.executeCommand("setContext", CURSOR_ON_THREAD_CONTEXT, value);
  }

  dispose(): void {
    this.subscriptions.forEach(subscription => subscription.dispose());
  }
}

async function confirmDelete(message: string): Promise<boolean> {
  return await vscode.window.showWarningMessage(message, { modal: true }, "Delete") === "Delete";
}
