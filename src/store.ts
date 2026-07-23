import { randomUUID } from "node:crypto";
import { CreateCommentInput, ReviewComment } from "./model";

export interface CommentPersistence {
  load(): ReviewRelayState;
  save(state: ReviewRelayState): PromiseLike<void>;
}

export interface ReviewRelayState {
  comments: ReviewComment[];
  overall: string;
  includeAiGenerated: boolean;
}

export interface RemoveCommentsResult {
  removed: number;
  remainingComments: number;
}

export class CommentStore {
  private state: ReviewRelayState;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly persistence: CommentPersistence) {
    this.state = persistence.load();
  }

  list(): readonly ReviewComment[] { return this.state.comments; }
  getOverall(): string { return this.state.overall; }
  includesAiGenerated(): boolean { return this.state.includeAiGenerated; }

  async add(input: CreateCommentInput): Promise<ReviewComment> {
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
    await this.commit();
    return comment;
  }

  async remove(id: string): Promise<RemoveCommentsResult> {
    return this.removeMany([id]);
  }

  async removeMany(ids: readonly string[]): Promise<RemoveCommentsResult> {
    const removedIds = new Set(ids);
    const next = this.state.comments.filter(comment => !removedIds.has(comment.id));
    const removed = this.state.comments.length - next.length;
    if (removed === 0) return { removed: 0, remainingComments: this.state.comments.length };
    this.state = { ...this.state, comments: next };
    await this.commit();
    return { removed, remainingComments: next.length };
  }

  async update(id: string, body: string): Promise<boolean> {
    const trimmed = body.trim();
    if (!trimmed) return false;
    const index = this.state.comments.findIndex(comment => comment.id === id);
    if (index < 0) return false;
    this.state = {
      ...this.state,
      comments: this.state.comments.map((comment, commentIndex) =>
        commentIndex === index ? { ...comment, body: trimmed } : comment
      )
    };
    await this.commit();
    return true;
  }

  async clear(): Promise<RemoveCommentsResult> {
    const removed = this.state.comments.length;
    if (removed === 0) return { removed: 0, remainingComments: 0 };
    this.state = { ...this.state, comments: [] };
    await this.commit();
    return { removed, remainingComments: 0 };
  }

  async setOverall(overall: string): Promise<void> {
    if (overall === this.state.overall) return;
    this.state = { ...this.state, overall };
    await this.commit();
  }

  async setIncludeAiGenerated(includeAiGenerated: boolean): Promise<void> {
    if (includeAiGenerated === this.state.includeAiGenerated) return;
    this.state = { ...this.state, includeAiGenerated };
    await this.commit();
  }

  async clearReview(): Promise<void> {
    if (this.state.comments.length === 0 && this.state.overall.length === 0) return;
    this.state = { ...this.state, comments: [], overall: "" };
    await this.commit();
  }

  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private async commit(): Promise<void> {
    await this.persistence.save(this.state);
    this.listeners.forEach(listener => listener());
  }
}
