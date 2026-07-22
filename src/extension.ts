import * as vscode from "vscode";
import { CommentServer } from "./server";
import { CommentStore, ReviewRelayState } from "./store";
import { VsCodeComments } from "./vscodeComments";
import { createAgentInstructions } from "./agentInstructions";
import { VsCodeNavigationService } from "./navigation";
import { renderReviewMarkdown } from "./markdown";
import { ReviewViewProvider } from "./reviewView";
import { SessionRegistration } from "./sessionRegistry";

const STORAGE_KEY = "reviewRelay.state.v1";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const store = new CommentStore({
    load: () => context.workspaceState.get<ReviewRelayState>(STORAGE_KEY) ?? {
      comments: [],
      overall: "",
      includeAiGenerated: true
    },
    save: state => context.workspaceState.update(STORAGE_KEY, state)
  });
  const comments = new VsCodeComments(store);
  const server = new CommentServer(store, new VsCodeNavigationService());

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
  const workspacePaths = () => (vscode.workspace.workspaceFolders ?? [])
    .map(folder => folder.uri.fsPath);
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
  const copyAgentInstructions = async () => {
    const instructions = createAgentInstructions({
      endpoint,
      cliPath,
      workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map(folder => ({
        uri: folder.uri.toString(),
        path: folder.uri.fsPath
      }))
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
    vscode.commands.registerCommand("reviewRelay.addComment", () => comments.addAtSelection()),
    vscode.commands.registerCommand("reviewRelay.submitComment", (reply: vscode.CommentReply) => comments.submit(reply)),
    vscode.commands.registerCommand("reviewRelay.editComment", comment => comments.edit(comment)),
    vscode.commands.registerCommand("reviewRelay.saveComment", comment => comments.save(comment)),
    vscode.commands.registerCommand("reviewRelay.cancelEditComment", comment => comments.cancelEdit(comment)),
    vscode.commands.registerCommand("reviewRelay.deleteComment", comment => comments.remove(comment)),
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
