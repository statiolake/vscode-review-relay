import { randomUUID } from "node:crypto";
import {
  CreateCommentInput,
  CreateReplyInput,
  ReviewComment,
  ReviewRelayState,
  validateCommentBody,
  validateCommentId,
  validateCreateComment,
  validateCreateReply,
  validateIncludeAiGenerated,
  validateOverall,
  validateReviewRelayState
} from "./model";

export interface CommentPersistence {
  load(): unknown;
  save(state: ReviewRelayState): PromiseLike<void>;
}

export interface RemoveCommentsResult {
  removed: number;
  remainingComments: number;
}

export interface CommentStoreChange {
  comments?: true;
  overall?: true;
  includeAiGenerated?: true;
}

export class CommentStore {
  private state: ReviewRelayState;
  private readonly listeners = new Set<(change: CommentStoreChange) => void>();

  constructor(private readonly persistence: CommentPersistence) {
    this.state = validateReviewRelayState(persistence.load());
  }

  list(): readonly ReviewComment[] { return this.state.comments; }
  getOverall(): string { return this.state.overall; }
  includesAiGenerated(): boolean { return this.state.includeAiGenerated; }

  async add(input: CreateCommentInput): Promise<ReviewComment> {
    input = validateCreateComment(input);
    const comment: ReviewComment = {
      id: randomUUID(),
      uri: input.uri,
      range: {
        start: { line: input.line, character: 0 },
        end: { line: input.endLine ?? input.line, character: 0 }
      },
      body: input.body.trim(),
      author: input.author?.trim() || (input.source === "human" ? "Human" : "AI"),
      source: input.source ?? "agent",
      createdAt: new Date().toISOString()
    };
    this.state = { ...this.state, comments: [...this.state.comments, comment] };
    await this.commit({ comments: true });
    return comment;
  }

  async reply(commentId: string, input: CreateReplyInput): Promise<ReviewComment | undefined> {
    commentId = validateCommentId(commentId);
    input = validateCreateReply(input);
    const rootId = this.rootId(commentId);
    const root = rootId ? this.state.comments.find(comment => comment.id === rootId) : undefined;
    if (!root) return undefined;
    const comment: ReviewComment = {
      id: randomUUID(),
      parentId: root.id,
      uri: root.uri,
      range: root.range,
      body: input.body.trim(),
      author: input.author?.trim() || (input.source === "human" ? "Human" : "AI"),
      source: input.source ?? "agent",
      createdAt: new Date().toISOString()
    };
    this.state = { ...this.state, comments: [...this.state.comments, comment] };
    await this.commit({ comments: true });
    return comment;
  }

  rootId(id: string): string | undefined {
    const comment = this.state.comments.find(comment => comment.id === id);
    return comment?.parentId ?? comment?.id;
  }

  thread(rootId: string): readonly ReviewComment[] {
    return this.state.comments.filter(comment => comment.id === rootId || comment.parentId === rootId);
  }

  async remove(id: string): Promise<RemoveCommentsResult> {
    return this.removeMany([validateCommentId(id)]);
  }

  async removeMany(ids: readonly string[]): Promise<RemoveCommentsResult> {
    const removedIds = new Set(ids.map(validateCommentId));
    const next = this.state.comments.filter(comment =>
      !removedIds.has(comment.id) && (!comment.parentId || !removedIds.has(comment.parentId))
    );
    const removed = this.state.comments.length - next.length;
    if (removed === 0) return { removed: 0, remainingComments: this.state.comments.length };
    this.state = { ...this.state, comments: next };
    await this.commit({ comments: true });
    return { removed, remainingComments: next.length };
  }

  async update(id: string, body: string): Promise<boolean> {
    id = validateCommentId(id);
    const trimmed = validateCommentBody(body);
    const index = this.state.comments.findIndex(comment => comment.id === id);
    if (index < 0) return false;
    this.state = {
      ...this.state,
      comments: this.state.comments.map((comment, commentIndex) =>
        commentIndex === index ? { ...comment, body: trimmed } : comment
      )
    };
    await this.commit({ comments: true });
    return true;
  }

  async clear(): Promise<RemoveCommentsResult> {
    const removed = this.state.comments.length;
    if (removed === 0) return { removed: 0, remainingComments: 0 };
    this.state = { ...this.state, comments: [] };
    await this.commit({ comments: true });
    return { removed, remainingComments: 0 };
  }

  async setOverall(overall: string): Promise<void> {
    overall = validateOverall(overall);
    if (overall === this.state.overall) return;
    this.state = { ...this.state, overall };
    await this.commit({ overall: true });
  }

  async setIncludeAiGenerated(includeAiGenerated: boolean): Promise<void> {
    includeAiGenerated = validateIncludeAiGenerated(includeAiGenerated);
    if (includeAiGenerated === this.state.includeAiGenerated) return;
    this.state = { ...this.state, includeAiGenerated };
    await this.commit({ includeAiGenerated: true });
  }

  async clearReview(): Promise<void> {
    if (this.state.comments.length === 0 && this.state.overall.length === 0) return;
    const hadComments = this.state.comments.length > 0;
    const hadOverall = this.state.overall.length > 0;
    this.state = { ...this.state, comments: [], overall: "" };
    await this.commit({
      ...(hadComments ? { comments: true } : {}),
      ...(hadOverall ? { overall: true } : {})
    });
  }

  onDidChange(listener: (change: CommentStoreChange) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private async commit(change: CommentStoreChange): Promise<void> {
    this.state = validateReviewRelayState(this.state);
    await this.persistence.save(this.state);
    this.listeners.forEach(listener => listener(change));
  }
}
