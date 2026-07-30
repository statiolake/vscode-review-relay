import { z } from "zod";
import { URI } from "vscode-uri";

const MAX_URI_LENGTH = 16 * 1024;
const MAX_BODY_LENGTH = 64 * 1024;
const MAX_AUTHOR_LENGTH = 256;
const MAX_OVERALL_LENGTH = 1024 * 1024;

const nonNegativeInteger = z.number().int().nonnegative();
const commentIdSchema = z.uuid();
const commentSourceSchema = z.enum(["human", "agent"]);
const bodyInputSchema = z.string()
  .trim()
  .min(1, "body is required.")
  .max(MAX_BODY_LENGTH, `body must not exceed ${MAX_BODY_LENGTH} characters.`);
const authorInputSchema = z.string()
  .trim()
  .min(1, "author must not be empty.")
  .max(MAX_AUTHOR_LENGTH, `author must not exceed ${MAX_AUTHOR_LENGTH} characters.`);
const bodySchema = z.string()
  .min(1, "body is required.")
  .max(MAX_BODY_LENGTH, `body must not exceed ${MAX_BODY_LENGTH} characters.`)
  .refine(value => value === value.trim(), "body must not contain leading or trailing whitespace.");
const authorSchema = z.string()
  .min(1, "author must not be empty.")
  .max(MAX_AUTHOR_LENGTH, `author must not exceed ${MAX_AUTHOR_LENGTH} characters.`)
  .refine(value => value === value.trim(), "author must not contain leading or trailing whitespace.");
const uriSchema = z.string()
  .min(1, "uri is required.")
  .max(MAX_URI_LENGTH, `uri must not exceed ${MAX_URI_LENGTH} characters.`)
  .refine(isValidDocumentUri, "uri must be a valid absolute VS Code document URI.");

const positionSchema = z.strictObject({
  line: nonNegativeInteger,
  character: nonNegativeInteger
});

const rangeSchema = z.strictObject({
  start: positionSchema,
  end: positionSchema
}).refine(range => comparePositions(range.end, range.start) >= 0, {
  message: "range.end must not precede range.start."
});

const reviewCommentSchema = z.strictObject({
  id: commentIdSchema,
  parentId: commentIdSchema.optional(),
  uri: uriSchema,
  range: rangeSchema,
  body: bodySchema,
  author: authorSchema,
  source: commentSourceSchema,
  createdAt: z.iso.datetime({ offset: true })
});

const createCommentSchema = z.strictObject({
  uri: uriSchema,
  line: nonNegativeInteger,
  endLine: nonNegativeInteger.optional(),
  body: bodyInputSchema,
  author: authorInputSchema.optional(),
  source: commentSourceSchema.optional()
}).refine(input => input.endLine === undefined || input.endLine >= input.line, {
  message: "endLine must be greater than or equal to line.",
  path: ["endLine"]
});

const createReplySchema = z.strictObject({
  body: bodyInputSchema,
  author: authorInputSchema.optional(),
  source: commentSourceSchema.optional()
});

const navigateByCommentSchema = z.strictObject({ commentId: commentIdSchema });
const navigateByLocationSchema = z.strictObject({
  uri: uriSchema,
  line: nonNegativeInteger,
  endLine: nonNegativeInteger.optional()
}).refine(input => input.endLine === undefined || input.endLine >= input.line, {
  message: "endLine must be greater than or equal to line.",
  path: ["endLine"]
});
const navigateSchema = z.union([navigateByCommentSchema, navigateByLocationSchema]);

export const reviewRelayStateSchema = z.strictObject({
  comments: z.array(reviewCommentSchema),
  overall: z.string().max(MAX_OVERALL_LENGTH, `overall must not exceed ${MAX_OVERALL_LENGTH} characters.`),
  showAgentLastOnly: z.boolean().default(false)
}).superRefine((state, context) => {
  const byId = new Map<string, ReviewComment>();
  for (const [index, comment] of state.comments.entries()) {
    if (byId.has(comment.id)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate comment id: ${comment.id}`,
        path: ["comments", index, "id"]
      });
    }
    byId.set(comment.id, comment);
  }

  for (const [index, comment] of state.comments.entries()) {
    if (!comment.parentId) continue;
    const parent = byId.get(comment.parentId);
    if (!parent) {
      context.addIssue({
        code: "custom",
        message: `Parent comment not found: ${comment.parentId}`,
        path: ["comments", index, "parentId"]
      });
      continue;
    }
    if (parent.uri !== comment.uri || !sameRange(parent.range, comment.range)) {
      context.addIssue({
        code: "custom",
        message: "A reply must have the same URI and range as its parent.",
        path: ["comments", index]
      });
    }
    if (hasParentCycle(comment, byId)) {
      context.addIssue({
        code: "custom",
        message: "Comment parent relationships must not contain a cycle.",
        path: ["comments", index, "parentId"]
      });
    }
  }
});

export type CommentSource = z.infer<typeof commentSourceSchema>;
export type ReviewComment = z.infer<typeof reviewCommentSchema>;
export type CreateCommentInput = z.infer<typeof createCommentSchema>;
export type CreateReplyInput = z.infer<typeof createReplySchema>;
export type ReviewRelayState = z.infer<typeof reviewRelayStateSchema>;
export type NavigateInput = z.infer<typeof navigateSchema>;

export interface NavigationTarget {
  uri: string;
  line: number;
  endLine: number;
  commentId?: string;
}

export function validateCommentId(value: unknown): string {
  return commentIdSchema.parse(value);
}

export function validateNavigate(value: unknown): NavigateInput {
  return navigateSchema.parse(value);
}

export function validateCreateComment(value: unknown): CreateCommentInput {
  return createCommentSchema.parse(value);
}

export function validateCreateReply(value: unknown): CreateReplyInput {
  return createReplySchema.parse(value);
}

export function validateCommentBody(value: unknown): string {
  return bodyInputSchema.parse(value);
}

export function validateOverall(value: unknown): string {
  return z.string().max(MAX_OVERALL_LENGTH, `overall must not exceed ${MAX_OVERALL_LENGTH} characters.`).parse(value);
}

export function validateShowAgentLastOnly(value: unknown): boolean {
  return z.boolean().parse(value);
}

export function validateReviewRelayState(value: unknown): ReviewRelayState {
  const state = reviewRelayStateSchema.parse(withoutLegacyExportPreference(value));
  const byId = new Map(state.comments.map(comment => [comment.id, comment]));
  return {
    ...state,
    comments: state.comments.map(comment => {
      if (!comment.parentId) return comment;
      let root = byId.get(comment.parentId)!;
      while (root.parentId) root = byId.get(root.parentId)!;
      return comment.parentId === root.id ? comment : { ...comment, parentId: root.id };
    })
  };
}

function withoutLegacyExportPreference(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const { includeAiGenerated: _legacy, ...state } = value as Record<string, unknown>;
  return state;
}

function isValidDocumentUri(value: string): boolean {
  if (/[\u0000-\u0020\u007f\\]/u.test(value) || /%(?![0-9a-fA-F]{2})/u.test(value)) return false;
  try {
    return URI.parse(value, true).toString() === value;
  } catch {
    return false;
  }
}

function comparePositions(
  left: { line: number; character: number },
  right: { line: number; character: number }
): number {
  return left.line - right.line || left.character - right.character;
}

function sameRange(left: ReviewComment["range"], right: ReviewComment["range"]): boolean {
  return left.start.line === right.start.line
    && left.start.character === right.start.character
    && left.end.line === right.end.line
    && left.end.character === right.end.character;
}

function hasParentCycle(comment: ReviewComment, byId: ReadonlyMap<string, ReviewComment>): boolean {
  const visited = new Set([comment.id]);
  let current = comment;
  while (current.parentId) {
    if (visited.has(current.parentId)) return true;
    visited.add(current.parentId);
    const parent = byId.get(current.parentId);
    if (!parent) return false;
    current = parent;
  }
  return false;
}
