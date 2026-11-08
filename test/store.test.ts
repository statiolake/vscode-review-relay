import assert from "node:assert/strict";
import test from "node:test";
import { importLegacyState, LEGACY_STORAGE_KEY } from "../src/migration";
import { absoluteUri, CommentStoreChange, relativePath } from "../src/store";
import { review } from "./review";

test("maps workspace-relative paths to the document URIs VS Code writes, and back", () => {
  const folder = "file:///home/me/my%20repo";
  assert.equal(absoluteUri(folder, "src/a b.ts"), "file:///home/me/my%20repo/src/a%20b.ts");
  assert.equal(relativePath(folder, "file:///home/me/my%20repo/src/a%20b.ts"), "src/a b.ts");
  assert.equal(relativePath(folder, "file:///home/me/other/a.ts"), undefined);
  assert.equal(relativePath(folder, "file:///home/me/my%20repo"), undefined);
  assert.equal(relativePath(folder, "untitled:Untitled-1"), undefined);
});

test("writes through the core and mirrors what it keeps", async () => {
  const r = await review();
  try {
    const changes: CommentStoreChange[] = [];
    r.store.onDidChange(change => changes.push(change));
    const root = await r.store.add({ uri: r.uri("app.ts"), line: 2, body: "  Why?  ", author: "Human", source: "human" });
    assert.equal(root.body, "Why?");
    assert.deepEqual(r.store.list().map(comment => [comment.uri, comment.range.start.line]), [[r.uri("app.ts"), 2]]);

    const reply = await r.store.reply(root.id, { uri: r.uri("lib/moved.ts"), line: 7, endLine: 9, body: "Moved it" });
    assert.equal(reply?.parentId, root.id);
    assert.ok(r.store.thread(root.id).every(comment =>
      comment.uri === r.uri("lib/moved.ts") && comment.range.start.line === 7 && comment.range.end.line === 9));

    assert.equal((await r.store.setResolved(reply!.id, true))?.resolved, true);
    // A move from an editor reopens nothing and adds nothing.
    assert.equal(await r.store.setThreadRange(root.id, { start: { line: 8, character: 0 }, end: { line: 10, character: 0 } }), true);
    assert.equal(r.store.list().find(comment => comment.id === root.id)?.resolved, true);
    assert.equal(r.store.thread(root.id).length, 2);
    assert.equal(r.store.isMoving(root.id), false);

    assert.equal(await r.store.update(reply!.id, "Edited"), true);
    assert.equal(r.store.thread(root.id)[1].body, "Edited");
    await r.store.setOverall("Overall");
    assert.equal(r.store.getOverall(), "Overall");
    assert.deepEqual(await r.store.remove(reply!.id), { removed: 1, remainingComments: 1 });
    assert.ok(changes.some(change => change.comments) && changes.some(change => change.overall));
    await assert.rejects(r.store.add({ uri: "file:///elsewhere/a.ts", line: 0, body: "x" }), /in none/);
    await assert.rejects(r.store.add({ uri: r.uri("a.ts"), line: 0, body: "   " }), /body is required/);
    await r.store.clearReview();
    assert.deepEqual([r.store.list().length, r.store.getOverall()], [0, ""]);
  } finally { r.close(); }
});

test("follows what another client of the same review does", async () => {
  const mine = await review();
  const theirs = await review(mine.dir);
  try {
    assert.equal(theirs.relay.current?.owner, false);
    assert.equal(theirs.relay.current?.endpoint, mine.relay.current?.endpoint);
    const seen = new Promise<void>(resolve => mine.store.onDidChange(change => { if (change.comments) resolve(); }));
    await theirs.store.add({ uri: theirs.uri("a.ts"), line: 1, body: "From the other editor" });
    await seen;
    assert.deepEqual(mine.store.list().map(comment => comment.body), ["From the other editor"]);
  } finally {
    theirs.close();
    mine.close();
  }
});

test("moves the review kept in the workspace state into the core, once", async () => {
  const r = await review();
  try {
    const at = (line: number) => ({ start: { line, character: 0 }, end: { line, character: 4 } });
    const root = "00000000-0000-4000-8000-000000000001";
    const memory = new Map<string, unknown>([[LEGACY_STORAGE_KEY, {
      overall: "Keep this",
      comments: [
        { id: root, uri: r.uri("a.ts"), range: at(3), body: "Root", author: "Human", source: "human", createdAt: "2026-01-01T00:00:00.000Z", resolved: true },
        { id: "00000000-0000-4000-8000-000000000002", parentId: root, uri: r.uri("a.ts"), range: at(3), body: "Reply", author: "AI", source: "agent", createdAt: "2026-01-01T00:01:00.000Z" },
        { id: "00000000-0000-4000-8000-000000000003", uri: "file:///elsewhere/b.ts", range: at(0), body: "Lost", author: "Human", source: "human", createdAt: "2026-01-01T00:02:00.000Z" }
      ]
    }]]);
    const storage = { get: <T>(key: string) => memory.get(key) as T | undefined, update: async (key: string, value: unknown) => { memory.set(key, value); } };
    assert.equal(await importLegacyState(storage, [r.backend]), 1);
    assert.equal(memory.get(LEGACY_STORAGE_KEY), undefined);
    assert.equal(await importLegacyState(storage, [r.backend]), undefined);
    const state = await r.backend.request<{ overall: string; comments: Array<{ id: string; body: string; resolved?: boolean }> }>("GET", "/v1/comments");
    assert.equal(state.overall, "Keep this");
    assert.deepEqual(state.comments.map(comment => [comment.id, comment.body, comment.resolved ?? false]), [
      [root, "Root", true], ["00000000-0000-4000-8000-000000000002", "Reply", false]
    ]);
  } finally { r.close(); }
});
