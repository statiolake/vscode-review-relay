import * as vscode from "vscode";
import { ReviewComment } from "./model";
import { CommentStore } from "./store";

export type CommentsTreeElement =
  | { kind: "file"; uri: string }
  | { kind: "location"; key: string }
  | { kind: "comment"; id: string };

interface LocationGroup {
  key: string;
  uri: string;
  startLine: number;
  endLine: number;
  comments: ReviewComment[];
}

export class CommentsTreeProvider implements vscode.TreeDataProvider<CommentsTreeElement>, vscode.Disposable {
  static readonly viewType = "reviewRelay.comments";
  private readonly changed = new vscode.EventEmitter<CommentsTreeElement | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly store: CommentStore) {
    this.subscription = store.onDidChange(() => this.changed.fire(undefined));
  }

  getTreeItem(element: CommentsTreeElement): vscode.TreeItem {
    if (element.kind === "file") {
      const comments = this.store.list().filter(comment => comment.uri === element.uri);
      const item = new vscode.TreeItem(documentLabel(element.uri), vscode.TreeItemCollapsibleState.Expanded);
      item.resourceUri = safeUri(element.uri);
      item.iconPath = new vscode.ThemeIcon("file");
      item.description = `${comments.length} comment${comments.length === 1 ? "" : "s"}`;
      item.contextValue = "reviewRelayFile";
      return item;
    }

    if (element.kind === "location") {
      const group = this.locations().get(element.key);
      if (!group) return new vscode.TreeItem("(missing location)");
      const lines = group.startLine === group.endLine
        ? `L${group.startLine + 1}`
        : `L${group.startLine + 1}–${group.endLine + 1}`;
      const preview = firstLine(group.comments[0]?.body ?? "");
      const item = new vscode.TreeItem(`${lines}${preview ? ` — ${preview}` : ""}`, vscode.TreeItemCollapsibleState.Collapsed);
      item.iconPath = new vscode.ThemeIcon("comment");
      item.description = `${group.comments.length}`;
      item.contextValue = "reviewRelayLocation";
      item.command = navigateCommand(group.comments[0]?.id);
      return item;
    }

    const comment = this.store.list().find(candidate => candidate.id === element.id);
    const item = new vscode.TreeItem(comment ? firstLine(comment.body) : "(missing comment)", vscode.TreeItemCollapsibleState.None);
    if (comment) {
      item.description = comment.author;
      item.tooltip = new vscode.MarkdownString(comment.body);
      item.iconPath = new vscode.ThemeIcon(comment.source === "agent" ? "sparkle" : "person");
      item.command = navigateCommand(comment.id);
    }
    item.contextValue = "reviewRelayComment";
    return item;
  }

  getChildren(element?: CommentsTreeElement): CommentsTreeElement[] {
    const locations = this.locations();
    if (!element) {
      return [...new Set(this.store.list().map(comment => comment.uri))]
        .sort((left, right) => documentLabel(left).localeCompare(documentLabel(right)))
        .map(uri => ({ kind: "file", uri }));
    }
    if (element.kind === "file") {
      return [...locations.values()]
        .filter(group => group.uri === element.uri)
        .sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine)
        .map(group => ({ kind: "location", key: group.key }));
    }
    if (element.kind === "location") {
      return (locations.get(element.key)?.comments ?? []).map(comment => ({ kind: "comment", id: comment.id }));
    }
    return [];
  }

  commentIds(element: CommentsTreeElement): string[] {
    if (element.kind === "comment") return [element.id];
    if (element.kind === "location") return this.locations().get(element.key)?.comments.map(comment => comment.id) ?? [];
    return [];
  }

  private locations(): Map<string, LocationGroup> {
    const groups = new Map<string, LocationGroup>();
    for (const comment of this.store.list()) {
      const key = locationKey(comment);
      const group = groups.get(key) ?? {
        key,
        uri: comment.uri,
        startLine: comment.range.start.line,
        endLine: comment.range.end.line,
        comments: []
      };
      group.comments.push(comment);
      groups.set(key, group);
    }
    return groups;
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }
}

function locationKey(comment: ReviewComment): string {
  return `${comment.uri}\0${comment.range.start.line}\0${comment.range.end.line}`;
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
