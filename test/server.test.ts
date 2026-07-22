import assert from "node:assert/strict";
import test from "node:test";
import { CommentServer } from "../src/server";
import { CommentStore } from "../src/store";
import { ReviewComment } from "../src/model";

test("comments round-trip through the loopback API", async () => {
  let persisted: ReviewComment[] = [];
  const store = new CommentStore({
    load: () => persisted,
    save: async comments => { persisted = [...comments]; }
  });
  const server = new CommentServer(store);
  const port = await server.start(0);
  const origin = `http://127.0.0.1:${port}`;

  try {
    const create = await fetch(`${origin}/v1/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uri: "file:///repo/app.ts", line: 4, body: "Check this", author: "Codex" })
    });
    assert.equal(create.status, 201);
    const created = await create.json() as { comment: ReviewComment };
    assert.equal(created.comment.body, "Check this");
    assert.equal(created.comment.source, "agent");

    const list = await fetch(`${origin}/v1/comments`);
    assert.deepEqual(await list.json(), { comments: [created.comment] });

    const remove = await fetch(`${origin}/v1/comments/${created.comment.id}`, { method: "DELETE" });
    assert.equal(remove.status, 200);
    assert.deepEqual(persisted, []);
  } finally {
    await server.stop();
  }
});

test("write endpoints reject browser-origin requests", async () => {
  const store = new CommentStore({ load: () => [], save: async () => undefined });
  const server = new CommentServer(store);
  const port = await server.start(0);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/comments`, {
      method: "POST",
      headers: { origin: "https://example.com", "content-type": "application/json" },
      body: "{}"
    });
    assert.equal(response.status, 403);
  } finally {
    await server.stop();
  }
});
