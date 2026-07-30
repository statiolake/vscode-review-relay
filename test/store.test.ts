import assert from "node:assert/strict";
import test from "node:test";
import { ReviewComment } from "../src/model";
import { CommentStore, CommentStoreChange } from "../src/store";

const ids = {
  one: "00000000-0000-4000-8000-000000000001",
  two: "00000000-0000-4000-8000-000000000002",
  root: "00000000-0000-4000-8000-000000000003",
  first: "00000000-0000-4000-8000-000000000004",
  second: "00000000-0000-4000-8000-000000000005",
  comment: "00000000-0000-4000-8000-000000000006",
  missing: "00000000-0000-4000-8000-000000000099"
} as const;

function comment(id: string, body = id): ReviewComment {
  return {
    id,
    uri: "file:///repo/app.ts",
    range: { start: { line: 2, character: 0 }, end: { line: 2, character: 0 } },
    body,
    author: "Human",
    source: "human",
    createdAt: "2026-01-01T00:00:00.000Z"
  };
}

test("updates a comment body without changing its identity", async () => {
  const original: ReviewComment = {
    id: ids.comment,
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

  assert.equal(await store.update(ids.comment, "  After  "), true);
  assert.deepEqual(persisted, [{ ...original, body: "After" }]);
  assert.equal(await store.update(ids.missing, "Nope"), false);
});

test("reports remaining comments after removal", async () => {
  const store = new CommentStore({
    load: () => ({
      comments: [comment(ids.one, "one"), comment(ids.two, "two")],
      overall: "",
      includeAiGenerated: true
    }),
    save: async () => undefined
  });

  assert.deepEqual(await store.remove(ids.one), { removed: 1, remainingComments: 1 });
  assert.deepEqual(await store.remove(ids.missing), { removed: 0, remainingComments: 1 });
});

test("stores replies in a thread and cascades deletion from their parent", async () => {
  const root = comment(ids.root, "root");
  let persisted = [root];
  const store = new CommentStore({
    load: () => ({ comments: persisted, overall: "", includeAiGenerated: true }),
    save: async state => { persisted = [...state.comments]; }
  });

  const reply = await store.reply(ids.root, { body: "  Reply  ", author: "Codex", source: "agent" });
  assert.ok(reply);
  assert.equal(reply.parentId, ids.root);
  assert.equal(reply.body, "Reply");
  assert.equal(store.rootId(reply.id), ids.root);
  assert.deepEqual(store.thread(ids.root).map(item => item.id), [ids.root, reply.id]);
  assert.equal(await store.reply(ids.missing, { body: "No parent" }), undefined);

  const secondReply = await store.reply(reply.id, { body: "Follow-up", author: "Human", source: "human" });
  assert.ok(secondReply);
  assert.equal(secondReply.parentId, ids.root);
  assert.deepEqual(store.thread(ids.root).map(item => item.id), [ids.root, reply.id, secondReply.id]);

  assert.deepEqual(await store.remove(ids.root), { removed: 3, remainingComments: 0 });
  assert.deepEqual(persisted, []);
});

test("deleting one reply preserves its parent and sibling replies", async () => {
  const root = comment(ids.root, "root");
  const first = { ...comment(ids.first, "first"), parentId: ids.root };
  const second = { ...comment(ids.second, "second"), parentId: ids.root };
  const store = new CommentStore({
    load: () => ({ comments: [root, first, second], overall: "", includeAiGenerated: true }),
    save: async () => undefined
  });

  assert.deepEqual(await store.remove(ids.first), { removed: 1, remainingComments: 2 });
  assert.deepEqual(store.list().map(item => item.id), [ids.root, ids.second]);
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

test("reports which part of the state changed", async () => {
  const store = new CommentStore({
    load: () => ({ comments: [], overall: "", includeAiGenerated: true }),
    save: async () => undefined
  });
  const changes: CommentStoreChange[] = [];
  store.onDidChange(change => changes.push(change));

  const added = await store.add({
    uri: "file:///repo/app.ts",
    line: 2,
    body: "Comment",
    source: "agent"
  });
  await store.setOverall("Overall");
  await store.setIncludeAiGenerated(false);
  await store.remove(added.id);

  assert.deepEqual(changes, [
    { comments: true },
    { overall: true },
    { includeAiGenerated: true },
    { comments: true }
  ]);
});

test("clear review reports every state domain it actually clears", async () => {
  const store = new CommentStore({
    load: () => ({
      comments: [comment(ids.one)],
      overall: "Overall",
      includeAiGenerated: true
    }),
    save: async () => undefined
  });
  const changes: CommentStoreChange[] = [];
  store.onDidChange(change => changes.push(change));

  await store.clearReview();

  assert.deepEqual(changes, [{ comments: true, overall: true }]);
});

test("fails fast without saving when persisted state is corrupted", () => {
  let saveCount = 0;
  assert.throws(() => new CommentStore({
    load: () => ({
      comments: [{ ...comment(ids.one), uri: "not-a-uri" }],
      overall: "",
      includeAiGenerated: true
    }),
    save: async () => { saveCount += 1; }
  }), /valid absolute VS Code document URI/);
  assert.equal(saveCount, 0);
});
