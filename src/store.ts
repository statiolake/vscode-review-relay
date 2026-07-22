import { randomUUID } from "node:crypto";
import { CreateCommentInput, ReviewComment } from "./model";

export interface CommentPersistence {
  load(): ReviewComment[];
  save(comments: ReviewComment[]): PromiseLike<void>;
}

export class CommentStore {
  private comments: ReviewComment[];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly persistence: CommentPersistence) {
    this.comments = persistence.load();
  }

  list(): readonly ReviewComment[] { return this.comments; }

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
    this.comments = [...this.comments, comment];
    await this.commit();
    return comment;
  }

  async remove(id: string): Promise<boolean> {
    const next = this.comments.filter(comment => comment.id !== id);
    if (next.length === this.comments.length) return false;
    this.comments = next;
    await this.commit();
    return true;
  }

  async clear(): Promise<number> {
    const count = this.comments.length;
    if (count === 0) return 0;
    this.comments = [];
    await this.commit();
    return count;
  }

  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private async commit(): Promise<void> {
    await this.persistence.save(this.comments);
    this.listeners.forEach(listener => listener());
  }
}
