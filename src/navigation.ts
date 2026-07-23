import * as vscode from "vscode";
import { NavigationTarget } from "./model";

export interface NavigationService {
  navigate(target: NavigationTarget, origin: "external" | "user"): Promise<void>;
}

export class VsCodeNavigationService implements NavigationService {
  async navigate(target: NavigationTarget, origin: "external" | "user"): Promise<void> {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(target.uri));
    if (target.line >= document.lineCount || target.endLine >= document.lineCount) {
      throw new Error(`Navigation range is outside the document (${document.lineCount} lines).`);
    }
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    const range = new vscode.Range(target.line, 0, target.endLine, document.lineAt(target.endLine).text.length);
    editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    if (origin === "external") {
      const location = `${vscode.workspace.asRelativePath(document.uri, false)}:${target.line + 1}`;
      const subject = target.commentId ? `comment ${target.commentId}` : location;
      void vscode.window.showInformationMessage(`Review Relay opened ${subject}.`);
    }
  }
}
