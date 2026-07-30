import assert from "node:assert/strict";
import test from "node:test";
import { CommentServer } from "../src/server";
import { CommentStore } from "../src/store";
import { ReviewComment } from "../src/model";

function createNavigationSpy() {
  const targets: Array<{ target: { uri: string; line: number; endLine: number }; origin: "external" | "user" }> = [];
  return {
    targets,
    service: {
      navigate: async (target: { uri: string; line: number; endLine: number }, origin: "external" | "user") => {
        targets.push({ target, origin });
      }
    }
  };
}

test("comments round-trip through the loopback API", async () => {
  let persisted: ReviewComment[] = [];
  const store = new CommentStore({
    load: () => ({ comments: persisted, overall: "Review the error handling." }),
    save: async state => { persisted = [...state.comments]; }
  });
  const navigation = createNavigationSpy();
  const server = new CommentServer(store, navigation.service);
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
    assert.deepEqual(await list.json(), { overall: "Review the error handling.", comments: [created.comment] });

    const replyResponse = await fetch(`${origin}/v1/comments/${created.comment.id}/replies`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "Fixed in the caller too.", author: "Codex" })
    });
    assert.equal(replyResponse.status, 201);
    const replied = await replyResponse.json() as { comment: ReviewComment };
    assert.equal(replied.comment.parentId, created.comment.id);
    assert.equal(replied.comment.uri, created.comment.uri);
    assert.deepEqual(replied.comment.range, created.comment.range);

    const followUpResponse = await fetch(`${origin}/v1/comments/${replied.comment.id}/replies`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "One more thought.", author: "Codex" })
    });
    assert.equal(followUpResponse.status, 201);
    const followUp = await followUpResponse.json() as { comment: ReviewComment };
    assert.equal(followUp.comment.parentId, created.comment.id);

    const missingId = "00000000-0000-4000-8000-000000000099";
    const missingReply = await fetch(`${origin}/v1/comments/${missingId}/replies`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "No parent" })
    });
    assert.equal(missingReply.status, 404);

    const navigate = await fetch(`${origin}/v1/navigate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commentId: created.comment.id })
    });
    assert.equal(navigate.status, 200);
    assert.deepEqual(navigation.targets, [{
      target: { uri: "file:///repo/app.ts", line: 4, endLine: 4, commentId: created.comment.id },
      origin: "external"
    }]);

    const navigateToLocation = await fetch(`${origin}/v1/navigate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uri: "file:///repo/other.ts", line: 8, endLine: 10 })
    });
    assert.equal(navigateToLocation.status, 200);
    assert.deepEqual(navigation.targets[1], {
      target: { uri: "file:///repo/other.ts", line: 8, endLine: 10 },
      origin: "external"
    });

    const missing = await fetch(`${origin}/v1/navigate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commentId: missingId })
    });
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "Comment not found." });

    const secondCreate = await fetch(`${origin}/v1/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uri: "file:///repo/other.ts", line: 9, body: "One more comment" })
    });
    assert.equal(secondCreate.status, 201);
    const second = await secondCreate.json() as { comment: ReviewComment };

    const remove = await fetch(`${origin}/v1/comments/${created.comment.id}`, { method: "DELETE" });
    assert.equal(remove.status, 200);
    assert.deepEqual(await remove.json(), { removed: true, remainingComments: 1 });
    assert.deepEqual(persisted, [second.comment]);
  } finally {
    await server.stop();
  }
});

test("write endpoints reject browser-origin requests", async () => {
  const store = new CommentStore({
    load: () => ({ comments: [], overall: "" }),
    save: async () => undefined
  });
  const server = new CommentServer(store, createNavigationSpy().service);
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

test("API rejects invalid comments before they reach persistence", async () => {
  let saveCount = 0;
  const store = new CommentStore({
    load: () => ({ comments: [], overall: "" }),
    save: async () => { saveCount += 1; }
  });
  const server = new CommentServer(store, createNavigationSpy().service);
  const port = await server.start(0);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uri: "not a URI", line: 0, body: "This must not be stored" })
    });
    assert.equal(response.status, 400);
    assert.match((await response.json() as { error: string }).error, /valid absolute VS Code document URI/);
    assert.equal(saveCount, 0);
    assert.deepEqual(store.list(), []);
  } finally {
    await server.stop();
  }
});
