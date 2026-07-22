import * as vscode from "vscode";
import { CommentServer } from "./server";
import { CommentatorState, CommentStore } from "./store";
import { ReviewComment } from "./model";
import { VsCodeComments } from "./vscodeComments";
import { createAgentInstructions } from "./agentInstructions";
import { VsCodeNavigationService } from "./navigation";
import { renderReviewMarkdown } from "./markdown";
import { ReviewViewProvider } from "./reviewView";

const STORAGE_KEY = "commentator.state.v2";
const LEGACY_COMMENTS_KEY = "commentator.comments.v1";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const store = new CommentStore({
    load: () => context.workspaceState.get<CommentatorState>(STORAGE_KEY) ?? {
      comments: context.workspaceState.get<ReviewComment[]>(LEGACY_COMMENTS_KEY, []),
      overall: "",
      includeAiGenerated: true
    },
    save: state => context.workspaceState.update(STORAGE_KEY, state)
  });
  const comments = new VsCodeComments(store);
  const server = new CommentServer(store, new VsCodeNavigationService());
  const configuredPort = vscode.workspace.getConfiguration("commentator").get<number>("server.port", 47658);

  let port: number;
  try {
    port = await server.start(configuredPort);
  } catch (error) {
    void vscode.window.showErrorMessage(`Commentator could not start its local API on port ${configuredPort}: ${error instanceof Error ? error.message : error}`);
    comments.dispose();
    return;
  }

  const endpoint = `http://127.0.0.1:${port}`;
  const cliPlatform = process.platform === "win32" ? "windows" : process.platform;
  const cliArch = process.arch === "x64" ? "amd64" : process.arch;
  const cliName = process.platform === "win32" ? "commentator.exe" : "commentator";
  const cliPath = context.asAbsolutePath(`bin/${cliPlatform}-${cliArch}/${cliName}`);
  const reviewView = new ReviewViewProvider(store);
  const copyAgentInstructions = async () => {
    const instructions = createAgentInstructions({
      endpoint,
      cliPath,
      workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.toString())
    });
    await vscode.env.clipboard.writeText(instructions);
    void vscode.window.showInformationMessage("Copied Commentator agent instructions.");
  };
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  status.text = "$(comment-discussion) Commentator";
  status.tooltip = `Live comment API: ${endpoint}`;
  status.command = "commentator.copyEndpoint";
  status.show();

  context.subscriptions.push(
    comments,
    reviewView,
    status,
    { dispose: () => void server.stop() },
    vscode.window.registerWebviewViewProvider(ReviewViewProvider.viewType, reviewView, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.commands.registerCommand("commentator.addComment", () => comments.addAtSelection()),
    vscode.commands.registerCommand("commentator.submitComment", (reply: vscode.CommentReply) => comments.submit(reply)),
    vscode.commands.registerCommand("commentator.editComment", comment => comments.edit(comment)),
    vscode.commands.registerCommand("commentator.saveComment", comment => comments.save(comment)),
    vscode.commands.registerCommand("commentator.cancelEditComment", comment => comments.cancelEdit(comment)),
    vscode.commands.registerCommand("commentator.deleteComment", comment => comments.remove(comment)),
    vscode.commands.registerCommand("commentator.copyEndpoint", async () => {
      await vscode.env.clipboard.writeText(endpoint);
      void vscode.window.showInformationMessage(`Copied ${endpoint}`);
    }),
    vscode.commands.registerCommand("commentator.copyAgentInstructions", copyAgentInstructions),
    vscode.commands.registerCommand("commentator.copyMarkdown", async () => {
      await vscode.env.clipboard.writeText(await renderReviewMarkdown(store));
      void vscode.window.showInformationMessage("Copied review comments as Markdown.");
    }),
    vscode.commands.registerCommand("commentator.clearReview", async () => {
      const answer = await vscode.window.showWarningMessage(
        "Clear the overall comment and all inline comments?",
        { modal: true },
        "Clear Review"
      );
      if (answer === "Clear Review") await store.clearReview();
    }),
    vscode.commands.registerCommand("commentator.clearComments", async () => {
      const answer = await vscode.window.showWarningMessage("Delete all Commentator comments?", { modal: true }, "Delete All");
      if (answer === "Delete All") await store.clear();
    })
  );
}

export function deactivate(): void {}
