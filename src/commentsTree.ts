import * as vscode from "vscode";
import { CommentStore } from "./store";

export type CommentsTreeElement =
  | { kind: "file"; uri: string }
  | { kind: "thread"; id: string }
  | { kind: "comment"; id: string };

export class CommentsTreeProvider implements vscode.TreeDataProvider<CommentsTreeElement>, vscode.Disposable {
  static readonly viewType = "reviewRelay.comments";
  private readonly changed = new vscode.EventEmitter<CommentsTreeElement | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly store: CommentStore) {
    this.subscription = store.onDidChange(change => {
      if (change.comments || change.showAgentLastOnly) this.changed.fire(undefined);
    });
  }

  getTreeItem(element: CommentsTreeElement): vscode.TreeItem {
    if (element.kind === "file") {
      const threads = this.store.visibleThreadRoots().filter(comment => comment.uri === element.uri);
      const item = new vscode.TreeItem(documentLabel(element.uri), vscode.TreeItemCollapsibleState.Expanded);
      item.resourceUri = safeUri(element.uri);
      item.iconPath = new vscode.ThemeIcon("file");
      item.description = `${threads.length} thread${threads.length === 1 ? "" : "s"}`;
      item.contextValue = "reviewRelayFile";
      return item;
    }

    const comment = this.store.list().find(candidate => candidate.id === element.id);
    if (element.kind === "thread") {
      const replies = comment ? this.store.thread(comment.id).length - 1 : 0;
      const agentLast = comment ? this.store.lastComment(comment.id)?.source === "agent" : false;
      const lines = comment
        ? comment.range.start.line === comment.range.end.line
          ? `L${comment.range.start.line + 1}`
          : `L${comment.range.start.line + 1}–${comment.range.end.line + 1}`
        : "";
      const preview = firstLine(comment?.body ?? "");
      const item = new vscode.TreeItem(
        comment ? `${lines} — ${preview}` : "(missing thread)",
        vscode.TreeItemCollapsibleState.Collapsed
      );
      if (!comment) return item;
      const conversation = replies === 0
        ? comment.author
        : `${comment.author} · ${replies} ${replies === 1 ? "reply" : "replies"}`;
      const status = agentLast ? "Last response: AI" : "Waiting for AI";
      item.description = `${conversation} · ${status}`;
      const tooltip = new vscode.MarkdownString(`**${status}**\n\n${comment.body}`);
      tooltip.isTrusted = false;
      item.tooltip = tooltip;
      item.iconPath = new vscode.ThemeIcon(agentLast ? "comment-unresolved" : "comment");
      item.command = navigateCommand(comment.id);
      item.contextValue = "reviewRelayComment";
      return item;
    }

    const item = new vscode.TreeItem(comment ? firstLine(comment.body) : "(missing comment)");
    if (comment) {
      item.description = comment.author;
      const tooltip = new vscode.MarkdownString(comment.body);
      tooltip.isTrusted = false;
      item.tooltip = tooltip;
      item.iconPath = new vscode.ThemeIcon(comment.source === "agent" ? "sparkle" : "person");
      item.command = navigateCommand(comment.id);
    }
    item.contextValue = "reviewRelayComment";
    return item;
  }

  getChildren(element?: CommentsTreeElement): CommentsTreeElement[] {
    if (!element) {
      return [...new Set(this.store.visibleThreadRoots().map(comment => comment.uri))]
        .sort((left, right) => documentLabel(left).localeCompare(documentLabel(right)))
        .map(uri => ({ kind: "file", uri }));
    }
    if (element.kind === "file") {
      return this.store.visibleThreadRoots()
        .filter(comment => comment.uri === element.uri)
        .sort((left, right) =>
          left.range.start.line - right.range.start.line
          || left.range.end.line - right.range.end.line
          || left.createdAt.localeCompare(right.createdAt)
        )
        .map(comment => ({ kind: "thread", id: comment.id }));
    }
    if (element.kind === "thread") {
      return this.store.thread(element.id)
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
