import * as vscode from "vscode";
import { CommentStore, ReviewBackend } from "./store";
import { VsCodeComments } from "./vscodeComments";
import { VsCodeNavigationService } from "./navigation";
import { renderReviewMarkdown } from "./markdown";
import { ReviewViewProvider } from "./reviewView";
import { CommentsTreeElement, CommentsTreeProvider } from "./commentsTree";
import { CursorCommands } from "./cursorCommands";
import { RelayConnection } from "./relay";
import { importLegacyState } from "./migration";

/**
 * The VS Code frontend of a review. The review is the core's (cmd/review-relay,
 * bundled in bin/): each file workspace folder is attached to its review
 * server (relay.ts), which keeps, validates and stores the threads and tells
 * every client of a change. This extension shows them with VS Code's comment UI and writes
 * what the person does back through the same API.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const cliPlatform = process.platform === "win32" ? "windows" : process.platform;
  const cliArch = process.arch === "x64" ? "amd64" : process.arch;
  const cliName = process.platform === "win32" ? "review-relay.exe" : "review-relay";
  const cliPath = context.asAbsolutePath(`bin/${cliPlatform}-${cliArch}/${cliName}`);

  const store = new CommentStore();
  const comments = new VsCodeComments(store);
  const navigation = new VsCodeNavigationService();
  const attachedFolders = new Map<string, { relay: RelayConnection; backend: ReviewBackend; dispose(): void }>();

  const attachFolder = async (folder: vscode.WorkspaceFolder): Promise<void> => {
    const key = folder.uri.toString();
    if (folder.uri.scheme !== "file" || attachedFolders.has(key)) return;
    const relay = new RelayConnection(cliPath, folder.uri.fsPath);
    try {
      await relay.attached();
    } catch (error) {
      relay.dispose();
      void vscode.window.showErrorMessage(`Review Relay could not open the review of ${folder.name}: ${error instanceof Error ? error.message : error}`);
      return;
    }
    const backend: ReviewBackend = {
      folderUri: key,
      request: (method, path, body) => relay.request(method, path, body),
      onEvent: listener => relay.onEvent(listener)
    };
    const registration = await store.addFolder(backend);
    relay.onDidAttach(() => updateStatus());
    attachedFolders.set(key, { relay, backend, dispose: () => { registration.dispose(); relay.dispose(); } });
    updateStatus();
    try {
      const dropped = await importLegacyState(context.workspaceState, [...attachedFolders.values()].map(entry => entry.backend));
      if (dropped !== undefined) {
        void vscode.window.showInformationMessage(dropped > 0
          ? `Review Relay moved this workspace's comments into its review store; ${dropped} outside the workspace folders were dropped.`
          : "Review Relay moved this workspace's comments into its review store.");
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`Review Relay could not move this workspace's earlier comments: ${error instanceof Error ? error.message : error}`);
    }
  };
  const detachFolder = (folder: vscode.WorkspaceFolder): void => {
    attachedFolders.get(folder.uri.toString())?.dispose();
    attachedFolders.delete(folder.uri.toString());
    updateStatus();
  };
  const primary = () => [...attachedFolders.values()][0]?.relay.current;

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  status.text = "$(comment-discussion) Review Relay";
  status.command = "reviewRelay.copyEndpoint";
  const updateStatus = () => {
    const endpoints = [...attachedFolders.values()].flatMap(entry => entry.relay.current ? [entry.relay.current.endpoint] : []);
    status.tooltip = endpoints.length > 0 ? `Live comment API: ${endpoints.join(", ")}` : "Review Relay: no folder attached";
    if (endpoints.length > 0) status.show();
    else status.hide();
  };

  const reviewView = new ReviewViewProvider(store);
  const commentsTree = new CommentsTreeProvider(store);
  const cursor = new CursorCommands(store, comments);
  const copyAgentInstructions = async () => {
    const texts = await Promise.all([...attachedFolders.values()].map(async entry =>
      (await entry.backend.request<{ text: string }>("GET", "/v1/instructions")).text));
    if (texts.length === 0) {
      void vscode.window.showWarningMessage("Review Relay: open a folder to review first.");
      return;
    }
    await vscode.env.clipboard.writeText(texts.join("\n\n---\n\n"));
    void vscode.window.showInformationMessage("Copied Review Relay agent instructions.");
  };

  context.subscriptions.push(
    comments,
    reviewView,
    commentsTree,
    cursor,
    status,
    { dispose: () => { attachedFolders.forEach(entry => entry.dispose()); attachedFolders.clear(); } },
    vscode.workspace.onDidChangeWorkspaceFolders(event => {
      event.removed.forEach(detachFolder);
      event.added.forEach(folder => void attachFolder(folder));
    }),
    store.onDidNavigate(target => {
      void navigation.navigate(target, "external").then(
        () => { if (target.commentId) comments.expandThread(target.commentId); },
        error => void vscode.window.showErrorMessage(`Review Relay could not open ${target.uri}: ${error instanceof Error ? error.message : error}`)
      );
    }),
    vscode.window.registerWebviewViewProvider(ReviewViewProvider.viewType, reviewView, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.window.registerTreeDataProvider(CommentsTreeProvider.viewType, commentsTree),
    vscode.commands.registerCommand("reviewRelay.addComment", () => comments.addAtSelection()),
    vscode.commands.registerCommand("reviewRelay.submitComment", (reply: vscode.CommentReply) => comments.submit(reply)),
    // Comment-widget actions pass their comment or thread; without one (from a
    // keybinding) they act on the cursor line like the *AtCursor commands.
    vscode.commands.registerCommand("reviewRelay.replyComment", (reply?: vscode.CommentReply) =>
      reply ? comments.submit(reply) : cursor.reply()),
    vscode.commands.registerCommand("reviewRelay.editComment", comment => comment ? comments.edit(comment) : cursor.edit()),
    vscode.commands.registerCommand("reviewRelay.saveComment", comment => comments.save(comment)),
    vscode.commands.registerCommand("reviewRelay.cancelEditComment", comment => comments.cancelEdit(comment)),
    vscode.commands.registerCommand("reviewRelay.deleteComment", comment =>
      comment ? comments.remove(comment) : cursor.deleteComment()),
    vscode.commands.registerCommand("reviewRelay.replyAtCursor", () => cursor.reply()),
    vscode.commands.registerCommand("reviewRelay.editAtCursor", () => cursor.edit()),
    vscode.commands.registerCommand("reviewRelay.deleteCommentAtCursor", () => cursor.deleteComment()),
    vscode.commands.registerCommand("reviewRelay.deleteThreadAtCursor", () => cursor.deleteThread()),
    vscode.commands.registerCommand("reviewRelay.toggleThreadAtCursor", () => cursor.toggleThread()),
    vscode.commands.registerCommand("reviewRelay.toggleResolveAtCursor", () => cursor.toggleResolved()),
    vscode.commands.registerCommand("reviewRelay.resolveThread", async (target?: unknown) => {
      const id = commentIdOf(target);
      return id ? cursor.setResolved(id, true) : cursor.toggleResolved();
    }),
    vscode.commands.registerCommand("reviewRelay.unresolveThread", async (target?: unknown) => {
      const id = commentIdOf(target);
      return id ? cursor.setResolved(id, false) : cursor.toggleResolved();
    }),
    vscode.commands.registerCommand("reviewRelay.deleteTreeComment", async (element: CommentsTreeElement) => {
      if (!element || element.kind === "file") return;
      await store.remove(element.id);
    }),
    vscode.commands.registerCommand("reviewRelay.navigateTreeComment", async (id: string) => {
      const comment = store.list().find(candidate => candidate.id === id);
      if (!comment) return;
      try {
        await navigation.navigate({ uri: comment.uri, line: comment.range.start.line,
          endLine: comment.range.end.line, commentId: id }, "user");
        comments.expandThread(id);
      } catch (error) {
        void vscode.window.showErrorMessage(`Review Relay could not open this comment's location: ${error instanceof Error ? error.message : error}`);
      }
    }),
    vscode.commands.registerCommand("reviewRelay.copyCommentId", async (target: unknown) => {
      const id = commentIdOf(target);
      if (!id || !store.list().some(comment => comment.id === id)) return;
      await vscode.env.clipboard.writeText(id);
    }),
    vscode.commands.registerCommand("reviewRelay.copyEndpoint", async () => {
      const endpoint = primary()?.endpoint;
      if (!endpoint) return;
      await vscode.env.clipboard.writeText(endpoint);
      void vscode.window.showInformationMessage(`Copied ${endpoint}`);
    }),
    vscode.commands.registerCommand("reviewRelay.copyAgentInstructions", copyAgentInstructions),
    vscode.commands.registerCommand("reviewRelay.copyMarkdown", async () => {
      await vscode.env.clipboard.writeText(await renderReviewMarkdown(store));
      void vscode.window.showInformationMessage("Copied review comments as Markdown.");
    }),
    vscode.commands.registerCommand("reviewRelay.clearReview", async () => {
      const answer = await vscode.window.showWarningMessage(
        "Clear the overall comment and all inline comments?",
        { modal: true },
        "Clear Review"
      );
      if (answer === "Clear Review") await store.clearReview();
    }),
    vscode.commands.registerCommand("reviewRelay.clearComments", async () => {
      const answer = await vscode.window.showWarningMessage("Delete all Review Relay comments?", { modal: true }, "Delete All");
      if (answer === "Delete All") await store.clear();
    })
  );
  await Promise.all((vscode.workspace.workspaceFolders ?? []).map(attachFolder));
}

export function deactivate(): void {}

function commentIdOf(target: unknown): string | undefined {
  if (!target || typeof target !== "object") return undefined;
  if ("reviewRelayId" in target && typeof target.reviewRelayId === "string") return target.reviewRelayId;
  if ("kind" in target && (target.kind === "thread" || target.kind === "comment")
    && "id" in target && typeof target.id === "string") return target.id;
  return undefined;
}
