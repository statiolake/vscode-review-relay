import assert from "node:assert/strict";
import test from "node:test";
import { ReviewComment } from "../src/model";
import { CommentStore } from "../src/store";

function comment(id: string): ReviewComment {
  return {
    id,
    uri: "file:///repo/app.ts",
    range: { start: { line: 2, character: 0 }, end: { line: 2, character: 0 } },
    body: id,
    author: "Human",
    source: "human",
    createdAt: "2026-01-01T00:00:00.000Z"
  };
}

test("updates a comment body without changing its identity", async () => {
  const original: ReviewComment = {
    id: "comment-1",
    uri: "file:///repo/app.ts",
    range: { start: { line: 2, character: 0 }, end: { line: 2, character: 0 } },
    body: "Before",
    author: "Human",
    source: "human",
    createdAt: "2026-01-01T00:00:00.000Z"
  };
  let persisted = [original];
  const store = new CommentStore({
    load: () => ({ comments: persisted, overall: "", includeAiGenerated: true }),
    save: async state => { persisted = [...state.comments]; }
  });

  assert.equal(await store.update("comment-1", "  After  "), true);
  assert.deepEqual(persisted, [{ ...original, body: "After" }]);
  assert.equal(await store.update("missing", "Nope"), false);
});

test("reports remaining comments after removal", async () => {
  const store = new CommentStore({
    load: () => ({
      comments: [comment("one"), comment("two")],
      overall: "",
      includeAiGenerated: true
    }),
    save: async () => undefined
  });

  assert.deepEqual(await store.remove("one"), { removed: 1, remainingComments: 1 });
  assert.deepEqual(await store.remove("missing"), { removed: 0, remainingComments: 1 });
});

test("stores replies in a thread and cascades deletion from their parent", async () => {
  const root = comment("root");
  let persisted = [root];
  const store = new CommentStore({
    load: () => ({ comments: persisted, overall: "", includeAiGenerated: true }),
    save: async state => { persisted = [...state.comments]; }
  });

  const reply = await store.reply("root", { body: "  Reply  ", author: "Codex", source: "agent" });
  assert.ok(reply);
  assert.equal(reply.parentId, "root");
  assert.equal(reply.body, "Reply");
  assert.equal(store.rootId(reply.id), "root");
  assert.deepEqual(store.thread("root").map(item => item.id), ["root", reply.id]);
  assert.equal(await store.reply("missing", { body: "No parent" }), undefined);

  assert.deepEqual(await store.remove("root"), { removed: 2, remainingComments: 0 });
  assert.deepEqual(persisted, []);
});

test("deleting one reply preserves its parent and sibling replies", async () => {
  const root = comment("root");
  const first = { ...comment("first"), parentId: "root" };
  const second = { ...comment("second"), parentId: "root" };
  const store = new CommentStore({
    load: () => ({ comments: [root, first, second], overall: "", includeAiGenerated: true }),
    save: async () => undefined
  });

  assert.deepEqual(await store.remove("first"), { removed: 1, remainingComments: 2 });
  assert.deepEqual(store.list().map(item => item.id), ["root", "second"]);
});

test("persists overall review text and the AI export preference in the shared state", async () => {
  let saved = { comments: [] as ReviewComment[], overall: "", includeAiGenerated: true };
  const store = new CommentStore({
    load: () => saved,
    save: async state => { saved = { ...state, comments: [...state.comments] }; }
  });

  await store.setOverall("Check the error-handling strategy.");
  await store.setIncludeAiGenerated(false);

  assert.equal(store.getOverall(), "Check the error-handling strategy.");
  assert.equal(store.includesAiGenerated(), false);
  assert.deepEqual(saved, {
    comments: [],
    overall: "Check the error-handling strategy.",
    includeAiGenerated: false
  });
});
