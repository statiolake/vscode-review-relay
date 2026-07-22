export type CommentSource = "human" | "agent";

export interface ReviewComment {
  id: string;
  uri: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  body: string;
  author: string;
  source: CommentSource;
  createdAt: string;
}

export interface CreateCommentInput {
  uri: string;
  line: number;
  endLine?: number;
  body: string;
  author?: string;
  source?: CommentSource;
}

export type NavigateInput =
  | { commentId: string }
  | { uri: string; line: number; endLine?: number };

export interface NavigationTarget {
  uri: string;
  line: number;
  endLine: number;
  commentId?: string;
}

function requireLine(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${name} must be a zero-based non-negative integer.`);
  }
  return value as number;
}

export function validateNavigate(value: unknown): NavigateInput {
  if (!value || typeof value !== "object") throw new Error("Request body must be an object.");
  const input = value as Record<string, unknown>;
  if (typeof input.commentId === "string" && input.commentId.length > 0) {
    if (input.uri !== undefined || input.line !== undefined || input.endLine !== undefined) {
      throw new Error("Specify either commentId or uri and line, not both.");
    }
    return { commentId: input.commentId };
  }
  if (typeof input.uri !== "string" || input.uri.length === 0) throw new Error("uri is required when commentId is omitted.");
  const line = requireLine(input.line, "line");
  const endLine = input.endLine === undefined ? undefined : requireLine(input.endLine, "endLine");
  if (endLine !== undefined && endLine < line) throw new Error("endLine must be greater than or equal to line.");
  return { uri: input.uri, line, ...(endLine === undefined ? {} : { endLine }) };
}

export function validateCreateComment(value: unknown): CreateCommentInput {
  if (!value || typeof value !== "object") throw new Error("Request body must be an object.");
  const input = value as Record<string, unknown>;
  if (typeof input.uri !== "string" || input.uri.length === 0) throw new Error("uri is required.");
  if (!Number.isInteger(input.line) || (input.line as number) < 0) throw new Error("line must be a zero-based non-negative integer.");
  if (typeof input.body !== "string" || input.body.trim().length === 0) throw new Error("body is required.");
  if (input.endLine !== undefined && (!Number.isInteger(input.endLine) || (input.endLine as number) < (input.line as number))) {
    throw new Error("endLine must be greater than or equal to line.");
  }
  if (input.author !== undefined && typeof input.author !== "string") throw new Error("author must be a string.");
  if (input.source !== undefined && input.source !== "human" && input.source !== "agent") throw new Error("source must be human or agent.");
  return input as unknown as CreateCommentInput;
}
