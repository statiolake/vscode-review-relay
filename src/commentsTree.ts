import * as vscode from "vscode";
import { CommentStore } from "./store";

export type CommentsTreeElement =
  | { kind: "file"; uri: string }
  | { kind: "comment"; id: string };

export class CommentsTreeProvider implements vscode.TreeDataProvider<CommentsTreeElement>, vscode.Disposable {
  static readonly viewType = "reviewRelay.comments";
  private readonly changed = new vscode.EventEmitter<CommentsTreeElement | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly store: CommentStore) {
    this.subscription = store.onDidChange(change => {
      if (change.comments) this.changed.fire(undefined);
    });
  }

  getTreeItem(element: CommentsTreeElement): vscode.TreeItem {
    if (element.kind === "file") {
      const threads = this.store.list().filter(comment => !comment.parentId && comment.uri === element.uri);
      const item = new vscode.TreeItem(documentLabel(element.uri), vscode.TreeItemCollapsibleState.Expanded);
      item.resourceUri = safeUri(element.uri);
      item.iconPath = new vscode.ThemeIcon("file");
      item.description = `${threads.length} thread${threads.length === 1 ? "" : "s"}`;
      item.contextValue = "reviewRelayFile";
      return item;
    }

    const comment = this.store.list().find(candidate => candidate.id === element.id);
    const replies = comment ? this.store.thread(comment.id).length - 1 : 0;
    const lines = comment
      ? comment.range.start.line === comment.range.end.line
        ? `L${comment.range.start.line + 1}`
        : `L${comment.range.start.line + 1}–${comment.range.end.line + 1}`
      : "";
    const preview = firstLine(comment?.body ?? "");
    const item = new vscode.TreeItem(comment ? `${lines} — ${preview}` : "(missing comment)");
    if (comment) {
      item.description = replies === 0
        ? comment.author
        : `${comment.author} · ${replies} ${replies === 1 ? "reply" : "replies"}`;
      item.tooltip = new vscode.MarkdownString(comment.body);
      item.iconPath = new vscode.ThemeIcon(comment.source === "agent" ? "sparkle" : "person");
      item.command = navigateCommand(comment.id);
    }
    item.contextValue = "reviewRelayComment";
    return item;
  }

  getChildren(element?: CommentsTreeElement): CommentsTreeElement[] {
    if (!element) {
      return [...new Set(this.store.list().filter(comment => !comment.parentId).map(comment => comment.uri))]
        .sort((left, right) => documentLabel(left).localeCompare(documentLabel(right)))
        .map(uri => ({ kind: "file", uri }));
    }
    if (element.kind === "file") {
      return this.store.list()
        .filter(comment => !comment.parentId)
        .filter(comment => comment.uri === element.uri)
        .sort((left, right) =>
          left.range.start.line - right.range.start.line
          || left.range.end.line - right.range.end.line
          || left.createdAt.localeCompare(right.createdAt)
        )
        .map(comment => ({ kind: "comment", id: comment.id }));
    }
    return [];
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }
}

function navigateCommand(id: string | undefined): vscode.Command | undefined {
  return id ? { command: "reviewRelay.navigateTreeComment", title: "Reveal Comment", arguments: [id] } : undefined;
}

function firstLine(value: string): string {
  const line = value.split("\n", 1)[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

function documentLabel(uriText: string): string {
  try {
    return vscode.workspace.asRelativePath(vscode.Uri.parse(uriText), false);
  } catch {
    return uriText;
  }
}

function safeUri(uriText: string): vscode.Uri | undefined {
  try {
    return vscode.Uri.parse(uriText);
  } catch {
    return undefined;
  }
}
