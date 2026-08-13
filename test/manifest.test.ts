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

test("runs in the workspace extension host", () => {
  assert.deepEqual(manifest.extensionKind, ["workspace"]);
});

test("offers comment ID copying in the native comment UI", () => {
  assert.ok(manifest.contributes?.commands?.some(item => item.command === "reviewRelay.copyCommentId"));
  assert.ok(manifest.contributes?.menus?.["comments/comment/title"]?.some(item => item.command === "reviewRelay.copyCommentId"));
});

test("keeps review controls in one panel", () => {
  assert.deepEqual(manifest.contributes?.views?.reviewRelay?.map(view => ({
    id: view.id,
    name: view.name,
    type: view.type
  })), [
    { id: "reviewRelay.review", name: "Review", type: "webview" }
  ]);
});
