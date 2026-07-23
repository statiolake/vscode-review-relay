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
