import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

interface Manifest {
  extensionKind?: string[];
  contributes?: {
    commands?: Array<{ command: string }>;
    menus?: Record<string, Array<{ command: string; group?: string; when?: string }>>;
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

test("offers deletion and ID copying directly on the custom comment tree", () => {
  const actions = manifest.contributes?.menus?.["view/item/context"] ?? [];
  for (const command of ["reviewRelay.deleteTreeComment", "reviewRelay.copyCommentId"]) {
    for (const group of ["inline", "navigation"]) {
      assert.ok(actions.some(item => item.command === command && item.group?.startsWith(group)
        && item.when === "view == reviewRelay.comments && viewItem == reviewRelayComment"));
    }
  }
  assert.ok(!manifest.contributes?.commands?.some(item => item.command === "reviewRelay.deleteThread"));
});

test("offers the comment tree alongside overall review controls", () => {
  assert.deepEqual(manifest.contributes?.views?.reviewRelay, [
    { id: "reviewRelay.comments", name: "Comments" },
    { id: "reviewRelay.review", name: "Review", type: "webview" }
  ]);
});
