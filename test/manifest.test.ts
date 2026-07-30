import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

interface Manifest {
  extensionKind?: string[];
  contributes?: {
    commands?: Array<{ command: string }>;
    menus?: Record<string, Array<{ command: string }>>;
    views?: Record<string, Array<{ id: string; name: string; type?: string }>>;
  };
}

const manifest = JSON.parse(readFileSync("package.json", "utf8")) as Manifest;

test("runs in the local UI extension host", () => {
  assert.deepEqual(manifest.extensionKind, ["ui"]);
});

test("offers comment ID copying in the tree and native comment UI", () => {
  assert.ok(manifest.contributes?.commands?.some(item => item.command === "reviewRelay.copyCommentId"));
  for (const menu of ["view/item/context", "comments/comment/title"]) {
    assert.ok(manifest.contributes?.menus?.[menu]?.some(item => item.command === "reviewRelay.copyCommentId"), menu);
  }
});

test("separates comment controls from the review editor", () => {
  assert.deepEqual(manifest.contributes?.views?.reviewRelay?.map(view => ({
    id: view.id,
    name: view.name,
    type: view.type
  })), [
    { id: "reviewRelay.comments", name: "Comments", type: undefined },
    { id: "reviewRelay.commentsControls", name: "Options", type: "webview" },
    { id: "reviewRelay.review", name: "Review", type: "webview" }
  ]);
});
