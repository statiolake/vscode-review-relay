import * as vscode from "vscode";
import { CommentServer } from "./server";
import { CommentStore } from "./store";
import { VsCodeComments } from "./vscodeComments";
import { AgentWorkspaceFolder, createAgentInstructions } from "./agentInstructions";
import { VsCodeNavigationService } from "./navigation";
import { renderReviewMarkdown } from "./markdown";
import { ReviewViewProvider } from "./reviewView";
import { SessionRegistration } from "./sessionRegistry";
import { CommentsTreeElement, CommentsTreeProvider } from "./commentsTree";
import { CommentsControlsViewProvider } from "./commentsControlsView";
import { createWorkspacePersistence, resetWorkspaceData } from "./workspacePersistence";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  let store: CommentStore;
  try {
    store = new CommentStore(createWorkspacePersistence(context.workspaceState));
  } catch (error) {
    await offerCorruptStateReset(context, error);
    return;
  }
  const comments = new VsCodeComments(store);
  const navigation = new VsCodeNavigationService();
  const server = new CommentServer(store, navigation);

  let port: number;
  try {
    port = await server.start(0);
  } catch (error) {
    void vscode.window.showErrorMessage(`Review Relay could not start its local API: ${error instanceof Error ? error.message : error}`);
    comments.dispose();
    return;
  }

  const endpoint = `http://127.0.0.1:${port}`;
  const session = new SessionRegistration(endpoint);
  const workspaceFolders = (): AgentWorkspaceFolder[] => (vscode.workspace.workspaceFolders ?? [])
    .map(folder => ({
      uri: folder.uri.toString(),
      ...(folder.uri.scheme === "file" ? { localPath: folder.uri.fsPath } : {})
    }));
  const workspacePaths = () => workspaceFolders()
    .flatMap(folder => folder.localPath ? [folder.localPath] : []);
  try {
    await session.update(workspacePaths());
  } catch (error) {
    await server.stop();
    comments.dispose();
    void vscode.window.showErrorMessage(`Review Relay could not register its local session: ${error instanceof Error ? error.message : error}`);
    return;
  }
  const cliPlatform = process.platform === "win32" ? "windows" : process.platform;
  const cliArch = process.arch === "x64" ? "amd64" : process.arch;
  const cliName = process.platform === "win32" ? "review-relay.exe" : "review-relay";
  const cliPath = context.asAbsolutePath(`bin/${cliPlatform}-${cliArch}/${cliName}`);
  const reviewView = new ReviewViewProvider(store);
  const commentsControlsView = new CommentsControlsViewProvider(store);
  const commentsTree = new CommentsTreeProvider(store);
  const copyAgentInstructions = async () => {
    const instructions = createAgentInstructions({
      endpoint,
      cliPath,
      workspaceFolders: workspaceFolders()
    });
    await vscode.env.clipboard.writeText(instructions);
    void vscode.window.showInformationMessage("Copied Review Relay agent instructions.");
  };
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  status.text = "$(comment-discussion) Review Relay";
  status.tooltip = `Live comment API: ${endpoint}`;
  status.command = "reviewRelay.copyEndpoint";
  status.show();

  context.subscriptions.push(
    comments,
    reviewView,
    commentsControlsView,
    commentsTree,
    status,
    { dispose: () => { void session.dispose(); void server.stop(); } },
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void session.update(workspacePaths()).catch(error => {
        void vscode.window.showErrorMessage(`Review Relay could not update its local session: ${error instanceof Error ? error.message : error}`);
      });
    }),
    vscode.window.registerWebviewViewProvider(ReviewViewProvider.viewType, reviewView, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.window.registerWebviewViewProvider(CommentsControlsViewProvider.viewType, commentsControlsView),
    vscode.window.registerTreeDataProvider(CommentsTreeProvider.viewType, commentsTree),
    vscode.commands.registerCommand("reviewRelay.addComment", () => comments.addAtSelection()),
    vscode.commands.registerCommand("reviewRelay.submitComment", (reply: vscode.CommentReply) => comments.submit(reply)),
    vscode.commands.registerCommand("reviewRelay.replyComment", (reply: vscode.CommentReply) => comments.submit(reply)),
    vscode.commands.registerCommand("reviewRelay.editComment", comment => comments.edit(comment)),
    vscode.commands.registerCommand("reviewRelay.saveComment", comment => comments.save(comment)),
    vscode.commands.registerCommand("reviewRelay.cancelEditComment", comment => comments.cancelEdit(comment)),
    vscode.commands.registerCommand("reviewRelay.deleteComment", comment => comments.remove(comment)),
    vscode.commands.registerCommand("reviewRelay.copyCommentId", async (target: unknown) => {
      const id = commentIdOf(target);
      if (!id || !store.list().some(comment => comment.id === id)) return;
      await vscode.env.clipboard.writeText(id);
    }),
    vscode.commands.registerCommand("reviewRelay.navigateTreeComment", async (id: string) => {
      const comment = store.list().find(candidate => candidate.id === id);
      if (!comment) return;
      const range = comments.currentRange(comment.id) ?? comment.range;
      await navigation.navigate({
        uri: comment.uri,
        line: range.start.line,
        endLine: range.end.line,
        commentId: comment.id
      }, "user");
      comments.expandThread(comment.id);
    }),
    vscode.commands.registerCommand("reviewRelay.deleteTreeComment", async (element: CommentsTreeElement) => {
      if (!element || element.kind === "file") return;
      await store.remove(element.id);
    }),
    vscode.commands.registerCommand("reviewRelay.copyEndpoint", async () => {
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
}

export function deactivate(): void {}

function commentIdOf(target: unknown): string | undefined {
  if (!target || typeof target !== "object") return undefined;
  if ("reviewRelayId" in target && typeof target.reviewRelayId === "string") return target.reviewRelayId;
  if (
    "kind" in target
    && (target.kind === "thread" || target.kind === "comment")
    && "id" in target
    && typeof target.id === "string"
  ) return target.id;
  return undefined;
}

async function offerCorruptStateReset(context: vscode.ExtensionContext, error: unknown): Promise<void> {
  const reason = error instanceof Error ? error.message : String(error);
  const action = await vscode.window.showErrorMessage(
    `Review Relay could not load this workspace because its stored data is corrupted. ${reason}`,
    "Reset Project Data"
  );
  if (action !== "Reset Project Data") return;

  try {
    await resetWorkspaceData(context.workspaceState);
  } catch (resetError) {
    const resetReason = resetError instanceof Error ? resetError.message : String(resetError);
    await vscode.window.showErrorMessage(`Review Relay could not reset the corrupted workspace data. ${resetReason}`);
    return;
  }

  await vscode.commands.executeCommand("workbench.action.reloadWindow");
}
