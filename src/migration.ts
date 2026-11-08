import { RelayComment } from "./model";
import { relativePath, ReviewBackend } from "./store";

/** Where Review Relay kept a workspace's review before review-relay held it. */
export const LEGACY_STORAGE_KEY = "reviewRelay.state.v1";

export interface WorkspaceMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

interface LegacyComment {
  id: string;
  parentId?: string;
  uri: string;
  range: { start: { line: number }; end: { line: number } };
  body: string;
  author: string;
  source: "human" | "agent";
  createdAt: string;
  resolved?: boolean;
}

/**
 * Moves the review this extension kept in the workspace state (up to 0.4)
 * into the folders' review-relay reviews, ids and authors kept, then forgets
 * it. review-relay validates what it imports and skips ids it has, so a
 * second run after a failure adds nothing twice. Answers how many comments
 * were in no workspace folder (and so were dropped), or undefined when
 * there was nothing to move.
 */
export async function importLegacyState(storage: WorkspaceMemento, folders: readonly ReviewBackend[]): Promise<number | undefined> {
  const state = storage.get<{ comments?: LegacyComment[]; overall?: string }>(LEGACY_STORAGE_KEY);
  if (!state || folders.length === 0) return undefined;
  const comments = Array.isArray(state.comments) ? state.comments : [];
  const byId = new Map(comments.map(comment => [comment.id, comment]));
  const rootOf = (comment: LegacyComment): LegacyComment => {
    let root = comment;
    for (let hops = 0; root.parentId && byId.has(root.parentId) && hops < comments.length; hops++) root = byId.get(root.parentId)!;
    return root;
  };
  const placed = new Set<string>();
  for (const folder of folders) {
    const mine: RelayComment[] = [];
    for (const comment of comments) {
      const root = rootOf(comment);
      const path = relativePath(folder.folderUri, root.uri);
      if (path === undefined) continue;
      placed.add(comment.id);
      mine.push({
        id: comment.id,
        ...(comment.id !== root.id ? { parentId: root.id } : {}),
        path,
        line: root.range.start.line,
        endLine: root.range.end.line,
        body: comment.body,
        author: comment.author,
        source: comment.source,
        createdAt: comment.createdAt,
        ...(comment.id === root.id && comment.resolved ? { resolved: true } : {})
      });
    }
    if (mine.length > 0) await folder.request("POST", "/v1/import", { comments: mine });
  }
  const overall = typeof state.overall === "string" ? state.overall.trim() : "";
  if (overall) {
    const current = await folders[0].request<{ overall: string }>("GET", "/v1/comments");
    if (!current.overall.trim()) await folders[0].request("PUT", "/v1/overall", { overall: state.overall });
  }
  await storage.update(LEGACY_STORAGE_KEY, undefined);
  return comments.length - placed.size;
}
