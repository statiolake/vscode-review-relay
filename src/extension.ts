import * as vscode from "vscode";
import { CommentServer } from "./server";
import { CommentStore } from "./store";
import { ReviewComment } from "./model";
import { VsCodeComments } from "./vscodeComments";
import { createAgentInstructions } from "./agentInstructions";

const STORAGE_KEY = "commentator.comments.v1";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const store = new CommentStore({
    load: () => context.workspaceState.get<ReviewComment[]>(STORAGE_KEY, []),
    save: comments => context.workspaceState.update(STORAGE_KEY, comments)
  });
  const comments = new VsCodeComments(store);
  const server = new CommentServer(store);
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
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  status.text = "$(comment-discussion) Commentator";
  status.tooltip = `Live comment API: ${endpoint}`;
  status.command = "commentator.copyEndpoint";
  status.show();

  context.subscriptions.push(
    comments,
    status,
    { dispose: () => void server.stop() },
    vscode.commands.registerCommand("commentator.addComment", () => comments.addAtSelection()),
    vscode.commands.registerCommand("commentator.submitComment", (reply: vscode.CommentReply) => comments.submit(reply)),
    vscode.commands.registerCommand("commentator.deleteComment", (thread: vscode.CommentThread) => comments.remove(thread)),
    vscode.commands.registerCommand("commentator.copyEndpoint", async () => {
      await vscode.env.clipboard.writeText(endpoint);
      void vscode.window.showInformationMessage(`Copied ${endpoint}`);
    }),
    vscode.commands.registerCommand("commentator.copyAgentInstructions", async () => {
      const instructions = createAgentInstructions({
        endpoint,
        workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.toString())
      });
      await vscode.env.clipboard.writeText(instructions);
      void vscode.window.showInformationMessage("Copied Commentator agent instructions.");
    }),
    vscode.commands.registerCommand("commentator.clearComments", async () => {
      const answer = await vscode.window.showWarningMessage("Delete all Commentator comments?", { modal: true }, "Delete All");
      if (answer === "Delete All") await store.clear();
    })
  );
}

export function deactivate(): void {}
