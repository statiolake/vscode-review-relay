import * as vscode from "vscode";
import { ReviewComment } from "./model";
import { CommentStore } from "./store";

interface LocationGroup {
  uri: string;
  startLine: number;
  endLine: number;
  comments: ReviewComment[];
}

export async function renderReviewMarkdown(store: CommentStore): Promise<string> {
  const parts: string[] = [];
  const overall = store.getOverall().trim();
  if (overall) parts.push(overall, "");

  const included = store.list().filter(comment => store.includesAiGenerated() || comment.source !== "agent");
  for (const group of groupByLocation(included)) {
    const label = documentLabel(group.uri);
    const lines = group.startLine === group.endLine
      ? `${group.startLine + 1}`
      : `${group.startLine + 1}-${group.endLine + 1}`;
    parts.push(`## ${label}:${lines}`, "");
    const snippet = await readSnippet(group);
    if (snippet !== undefined) parts.push(`\`\`\`${languageHint(group.uri)}`, snippet, "```", "");
    for (const comment of group.comments) {
      const author = comment.source === "agent" ? `**${comment.author} (AI):** ` : "";
      parts.push(`${author}${comment.body.trim()}`, "");
    }
  }

  const markdown = parts.join("\n").replace(/\n+$/, "");
  return markdown ? `${markdown}\n` : "";
}

function groupByLocation(comments: readonly ReviewComment[]): LocationGroup[] {
  const groups = new Map<string, LocationGroup>();
  for (const comment of comments) {
    const key = `${comment.uri}\0${comment.range.start.line}\0${comment.range.end.line}`;
    const group = groups.get(key) ?? {
      uri: comment.uri,
      startLine: comment.range.start.line,
      endLine: comment.range.end.line,
      comments: []
    };
    group.comments.push(comment);
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) =>
    left.uri.localeCompare(right.uri) || left.startLine - right.startLine
  );
}

async function readSnippet(group: LocationGroup): Promise<string | undefined> {
  try {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(group.uri));
    if (group.startLine >= document.lineCount) return undefined;
    const endLine = Math.min(group.endLine, document.lineCount - 1);
    return Array.from({ length: endLine - group.startLine + 1 }, (_, offset) =>
      document.lineAt(group.startLine + offset).text
    ).join("\n");
  } catch {
    return undefined;
  }
}

function documentLabel(uriText: string): string {
  try {
    return vscode.workspace.asRelativePath(vscode.Uri.parse(uriText), false);
  } catch {
    return uriText;
  }
}

function languageHint(uri: string): string {
  const extension = /\.([a-zA-Z0-9]+)(?:$|[?#])/.exec(uri)?.[1]?.toLowerCase();
  if (!extension) return "";
  return ({ py: "python", sh: "bash", yml: "yaml", rb: "ruby", cs: "csharp" } as Record<string, string>)[extension] ?? extension;
}
