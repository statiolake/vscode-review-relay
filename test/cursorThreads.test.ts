import assert from "node:assert/strict";
import test from "node:test";
import { numberComments, numberThreads, threadsAtLine } from "../src/cursorThreads";
import { ReviewComment } from "../src/model";

function comment(id: number, line: number, endLine: number, extra: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
    uri: "file:///repo/app.ts",
    range: { start: { line, character: 0 }, end: { line: endLine, character: 0 } },
    body: `Body ${id}\nmore`,
    author: "Human",
    source: "human",
    createdAt: `2026-01-01T00:00:0${id}.000Z`,
    ...extra
  };
}

test("finds root threads covering the cursor line in the standalone viewer's order", () => {
  const narrow = comment(1, 4, 4);
  const wide = comment(2, 4, 8);
  const earlier = comment(3, 2, 5);
  const reply = comment(4, 4, 4, { parentId: narrow.id });
  const elsewhere = comment(5, 4, 4, { uri: "file:///repo/other.ts" });
  const below = comment(6, 6, 9);
  const all = [narrow, wide, earlier, reply, elsewhere, below];

  assert.deepEqual(threadsAtLine(all, "file:///repo/app.ts", 4).map(root => root.id), [earlier.id, wide.id, narrow.id]);
  assert.deepEqual(threadsAtLine(all, "file:///repo/app.ts", 9).map(root => root.id), [below.id]);
  assert.deepEqual(threadsAtLine(all, "file:///repo/app.ts", 0), []);
});

test("numbers threads and comments from one for the quick pick", () => {
  const root = comment(1, 4, 6, { resolved: true });
  const reply = comment(2, 4, 6, { parentId: root.id, author: "Agent", source: "agent" });
  const [thread] = numberThreads([root], () => [root, reply]);
  assert.equal(thread.label, "1. Body 1");
  assert.equal(thread.description, "L5–7 · Human · 1 reply · resolved");
  assert.deepEqual(numberComments([root, reply]).map(item => [item.label, item.description]), [
    ["1. Body 1", "Human · first comment"],
    ["2. Body 2", "Agent"]
  ]);
});
