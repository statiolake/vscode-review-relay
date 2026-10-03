import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";
import { CommentStore } from "../src/store";

const threads: Array<{ uri: { toString(): string }; disposed: boolean; dispose(): void }> = [];
const api = {
  comments: { createCommentController: () => ({
    createCommentThread: (uri: { toString(): string }, range: unknown, comments: unknown[]) => {
      const thread = { uri, range, comments, disposed: false, dispose() { this.disposed = true; } };
      threads.push(thread);
      return thread;
    },
    dispose() {}
  }) },
  workspace: { onDidChangeTextDocument: () => ({ dispose() {} }) },
  Uri: { parse: (value: string) => ({ toString: () => value }) },
  Range: class {
    start: { line: number; character: number };
    end: { line: number; character: number };
    constructor(a: number, b: number, c: number, d: number) {
      this.start = { line: a, character: b }; this.end = { line: c, character: d };
    }
  },
  MarkdownString: class { constructor(public value: string) {} },
  CommentMode: { Preview: 0, Editing: 1 },
  CommentThreadState: { Unresolved: 0, Resolved: 1 }
};
const loader = Module as unknown as { _load: (request: string, ...args: unknown[]) => unknown };
const original = loader._load;
let Comments: typeof import("../src/vscodeComments").VsCodeComments;
try {
  loader._load = (request, ...args) => request === "vscode" ? api : original(request, ...args);
  Comments = require("../src/vscodeComments").VsCodeComments;
} finally { loader._load = original; }

test("recreates native threads at the new URI when a reply relocates the conversation", async () => {
  const store = new CommentStore({ load: () => ({ overall: "", comments: [] }), save: async () => {} });
  const root = await store.add({ uri: "file:///gone.ts", line: 0, body: "Move me" });
  const adapter = new Comments(store);
  try {
    const old = threads[0];
    await store.reply(root.id, { uri: "file:///new.ts", line: 4, endLine: 6, body: "Moved" });
    assert.equal(old.disposed, true);
    assert.equal(threads[1].uri.toString(), "file:///new.ts");
    assert.equal(store.thread(root.id).length, 2);
    assert.ok(store.thread(root.id).every(comment => comment.uri === "file:///new.ts" && comment.range.start.line === 4));
  } finally { adapter.dispose(); }
});
