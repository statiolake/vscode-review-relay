import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("runs in the local UI extension host", () => {
  const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
    extensionKind?: string[];
  };

  assert.deepEqual(manifest.extensionKind, ["ui"]);
});
