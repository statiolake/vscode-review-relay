// The review as VS Code shows it. The review itself lives in the core's
// server (cmd/review-relay; see relay.ts and store.ts), which validates and stores every
// change; this is its shape in editor terms: a document URI and a range.

export type CommentSource = "human" | "agent";

export interface Position {
  line: number;
  character: number;
}

export interface ReviewComment {
  id: string;
  parentId?: string;
  uri: string;
  range: { start: Position; end: Position };
  body: string;
  author: string;
  source: CommentSource;
  createdAt: string;
  /** Only on a thread's root, and only as true. A new reply reopens it. */
  resolved?: boolean;
}

export interface CreateCommentInput {
  uri: string;
  line: number;
  endLine?: number;
  body: string;
  author?: string;
  source?: CommentSource;
}

export type CreateReplyInput = CreateCommentInput;

export interface NavigationTarget {
  uri: string;
  line: number;
  endLine: number;
  commentId?: string;
}

/** A comment as the core's API has it: a workspace-relative path and lines. */
export interface RelayComment {
  id: string;
  parentId?: string;
  path: string;
  line: number;
  endLine: number;
  body: string;
  author: string;
  source: CommentSource;
  createdAt: string;
  resolved?: boolean;
}

/** Whether the thread rooted at (or containing) this comment is resolved. */
export function isThreadResolved(comments: readonly ReviewComment[], comment: ReviewComment): boolean {
  const rootId = comment.parentId ?? comment.id;
  return comments.find(candidate => candidate.id === rootId)?.resolved === true;
}

export function sameRange(left: ReviewComment["range"], right: ReviewComment["range"]): boolean {
  return left.start.line === right.start.line
    && left.start.character === right.start.character
    && left.end.line === right.end.line
    && left.end.character === right.end.character;
}

export function lineRange(line: number, endLine: number): ReviewComment["range"] {
  return { start: { line, character: 0 }, end: { line: endLine, character: 0 } };
}
