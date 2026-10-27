import * as vscode from "vscode";
import { lineLabel } from "./cursorThreads";
import { ReviewComment } from "./model";
import { CommentStore } from "./store";

type ThreadWithId = vscode.CommentThread & { reviewRelayId?: string };
type CommentWithId = vscode.Comment & { reviewRelayId: string; savedBody: string };

export class VsCodeComments implements vscode.Disposable {
  private readonly controller = vscode.comments.createCommentController("review-relay", "Review Relay");
  private readonly threads = new Map<string, vscode.CommentThread>();
  private readonly threadModels = new Map<string, readonly ReviewComment[]>();
  // Creation order of native threads: VS Code lists a line's widgets in it.
  private readonly created = new Map<string, number>();
  private sequence = 0;
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

  /**
   * Opens VS Code's own new-thread widget (what the gutter "+" opens) on the
   * selected lines, its input focused; submitting it goes through `submit`,
   * and VS Code drops the empty thread when the widget is closed. The lines
   * are read here, when the command starts, so a Vim visual selection ended
   * right after still gives them.
   */
  async addAtSelection(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const selection = editor.selections.length === 1 ? editor.selection : undefined;
    if (selection && selection.start.line === selection.end.line) {
      // VS Code's own path for one line (its range argument loses the start column)
      await vscode.commands.executeCommand("workbench.action.addComment");
      return;
    }
    const { start, end } = selectedLines(editor.selections);
    await vscode.commands.executeCommand("workbench.action.addComment", {
      range: {
        startLineNumber: start + 1,
        startColumn: 1,
        endLineNumber: end + 1,
        endColumn: editor.document.lineAt(end).text.length + 1
      }
    });
  }

  async submit(reply: vscode.CommentReply): Promise<void> {
    const thread = reply.thread as ThreadWithId;
    const text = reply.text.trim();
    if (!text || !thread.range) return;
    if (thread.reviewRelayId) {
      await this.store.reply(thread.reviewRelayId, {
        uri: thread.uri.toString(),
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
    const thread = this.nativeThread(commentId);
    if (thread) thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  }

  collapseThread(commentId: string): void {
    const thread = this.nativeThread(commentId);
    if (thread) thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
  }

  /** Expands a collapsed thread or collapses an expanded one. */
  toggleThread(commentId: string): void {
    const thread = this.nativeThread(commentId);
    if (!thread) return;
    thread.collapsibleState = thread.collapsibleState === vscode.CommentThreadCollapsibleState.Expanded
      ? vscode.CommentThreadCollapsibleState.Collapsed
      : vscode.CommentThreadCollapsibleState.Expanded;
  }

  /** Opens the thread and puts one of its comments in edit mode, focused. */
  editById(commentId: string): void {
    const thread = this.nativeThread(commentId);
    const comment = thread?.comments.find(candidate => (candidate as CommentWithId).reviewRelayId === commentId);
    if (!thread || !comment) return;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    this.edit(comment as CommentWithId);
  }

  /**
   * Opens the thread and focuses its reply editor. VS Code has no stable API
   * for that, so this moves the cursor to the thread's last line (where VS
   * Code anchors the thread), focuses the line's thread, steps from its
   * comments to its reply editor, and restores the selection.
   *
   * VS Code takes the first widget anchored on the line. When another thread
   * shares the anchor line and may precede this one, the reply goes through
   * an input box instead so it cannot land in the wrong thread.
   */
  async focusReply(rootId: string, editor: vscode.TextEditor): Promise<void> {
    const thread = this.threads.get(rootId);
    const root = this.store.list().find(comment => comment.id === rootId);
    if (!thread?.range || !root) return;
    if (thread.uri.toString() !== editor.document.uri.toString() || this.mayBeShadowed(rootId, thread)) {
      await this.replyWithInputBox(root, thread);
      return;
    }
    const selections = editor.selections;
    const anchor = thread.range.end.line;
    editor.selection = new vscode.Selection(anchor, 0, anchor, 0);
    try {
      await vscode.commands.executeCommand("workbench.action.focusCommentOnCurrentLine");
      await vscode.commands.executeCommand("widgetNavigation.focusNext");
    } finally {
      editor.selections = selections;
    }
  }

  private mayBeShadowed(rootId: string, thread: vscode.CommentThread): boolean {
    const order = this.created.get(rootId) ?? 0;
    const start = thread.range!.start.line;
    const anchor = thread.range!.end.line;
    for (const [otherId, other] of this.threads) {
      if (otherId === rootId || !other.range || other.uri.toString() !== thread.uri.toString()) continue;
      if (other.range.end.line !== anchor) continue;
      if ((this.created.get(otherId) ?? 0) < order || other.range.start.line < start) return true;
    }
    return false;
  }

  private async replyWithInputBox(root: ReviewComment, thread: vscode.CommentThread): Promise<void> {
    const body = await vscode.window.showInputBox({
      prompt: `Reply to the thread on ${lineLabel(root)}: ${root.body.split("\n", 1)[0]}`,
      ignoreFocusOut: true
    });
    if (!body?.trim() || !thread.range) return;
    await this.store.reply(root.id, {
      uri: thread.uri.toString(),
      line: thread.range.start.line,
      endLine: thread.range.end.line,
      body,
      author: "Human",
      source: "human"
    });
  }

  private nativeThread(commentId: string): vscode.CommentThread | undefined {
    const rootId = this.store.rootId(commentId);
    return rootId ? this.threads.get(rootId) : undefined;
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
      let existing = this.threads.get(root.id) as ThreadWithId | undefined;
      if (existing && existing.uri.toString() !== root.uri) {
        existing.dispose();
        this.threads.delete(root.id);
        this.threadModels.delete(root.id);
        this.created.delete(root.id);
        existing = undefined;
      }
      if (existing) {
        applyStatus(existing, comments);
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
        thread.canReply = true;
        applyStatus(thread, comments);
        this.threads.set(root.id, thread);
        this.created.set(root.id, this.sequence++);
        this.threadModels.set(root.id, comments);
      }
    }
    for (const id of remaining) {
      this.threads.get(id)?.dispose();
      this.threads.delete(id);
      this.threadModels.delete(id);
      this.created.delete(id);
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

/**
 * The lines the selections cover, as VS Code counts them for a command on the
 * selected lines: a selection ending at the start of a line leaves that line out.
 */
export function selectedLines(selections: readonly SelectionLike[]): { start: number; end: number } {
  let start = Infinity;
  let end = -Infinity;
  for (const { start: from, end: to } of selections) {
    start = Math.min(start, from.line);
    end = Math.max(end, to.character === 0 && to.line > from.line ? to.line - 1 : to.line);
  }
  return { start, end };
}

interface SelectionLike {
  readonly start: { readonly line: number };
  readonly end: { readonly line: number; readonly character: number };
}

function toReviewRange(range: vscode.Range): ReviewComment["range"] {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character }
  };
}

/**
 * Mirrors the thread's resolved flag into VS Code's native state (which drives
 * the Comments panel filter and the gutter icon) and names who answered last.
 */
function applyStatus(thread: vscode.CommentThread, comments: readonly ReviewComment[]): void {
  const resolved = comments[0]?.resolved === true;
  const state = resolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
  const contextValue = resolved ? "resolved" : "unresolved";
  const label = resolved
    ? "Resolved"
    : comments.at(-1)?.source === "agent" ? "Last response: AI" : "Waiting for AI";
  if (thread.state !== state) thread.state = state;
  if (thread.contextValue !== contextValue) thread.contextValue = contextValue;
  if (thread.label !== label) thread.label = label;
}

function sameComments(
  previous: readonly ReviewComment[] | undefined,
  current: readonly ReviewComment[]
): boolean {
  return previous?.length === current.length && current.every((comment, index) => comment === previous[index]);
}
