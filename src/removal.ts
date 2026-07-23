import * as vscode from "vscode";
import { RemoveCommentsResult } from "./store";

export function showRemovalResult(result: RemoveCommentsResult): void {
  if (result.removed === 0) return;
  const subject = result.removed === 1 ? "Comment deleted." : `${result.removed} comments deleted.`;
  void vscode.window.showInformationMessage(`${subject} Remaining comments: ${result.remainingComments}.`);
}
