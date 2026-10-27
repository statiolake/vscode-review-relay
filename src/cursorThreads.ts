import { ReviewComment } from "./model";

/**
 * Root comments of the threads in `uri` whose range covers `line`, ordered
 * like the standalone viewer numbers them: by start line, and the wider
 * thread first when two start together.
 */
export function threadsAtLine(comments: readonly ReviewComment[], uri: string, line: number): ReviewComment[] {
  return comments
    .filter(comment => !comment.parentId && comment.uri === uri
      && comment.range.start.line <= line && line <= comment.range.end.line)
    .sort((left, right) =>
      left.range.start.line - right.range.start.line
      || right.range.end.line - left.range.end.line
      || left.createdAt.localeCompare(right.createdAt)
    );
}

/** Editor line label for a thread range, one-based: "L3" or "L3–5". */
export function lineLabel(comment: ReviewComment): string {
  const start = comment.range.start.line + 1;
  const end = comment.range.end.line + 1;
  return start === end ? `L${start}` : `L${start}–${end}`;
}

export function firstLine(value: string, limit = 80): string {
  const line = value.split("\n", 1)[0] ?? "";
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}

export interface NumberedChoice<T> {
  label: string;
  description: string;
  value: T;
}

/** Quick pick items numbered from 1 for threads on the cursor line. */
export function numberThreads(
  roots: readonly ReviewComment[],
  threadOf: (rootId: string) => readonly ReviewComment[]
): NumberedChoice<ReviewComment>[] {
  return roots.map((root, index) => {
    const replies = threadOf(root.id).length - 1;
    const details = [
      lineLabel(root),
      root.author,
      ...(replies > 0 ? [`${replies} ${replies === 1 ? "reply" : "replies"}`] : []),
      ...(root.resolved ? ["resolved"] : [])
    ];
    return { label: `${index + 1}. ${firstLine(root.body)}`, description: details.join(" · "), value: root };
  });
}

/** Quick pick items numbered from 1 for the comments of one thread. */
export function numberComments(thread: readonly ReviewComment[]): NumberedChoice<ReviewComment>[] {
  return thread.map((comment, index) => ({
    label: `${index + 1}. ${firstLine(comment.body)}`,
    description: `${comment.author}${comment.parentId ? "" : " · first comment"}`,
    value: comment
  }));
}
