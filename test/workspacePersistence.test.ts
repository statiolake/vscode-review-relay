import assert from "node:assert/strict";
import test from "node:test";
import {
  createWorkspacePersistence,
  resetWorkspaceData,
  STORAGE_KEY,
  WorkspaceMemento
} from "../src/workspacePersistence";

test("uses an empty state when this workspace has no saved Review Relay data", () => {
  const storage: WorkspaceMemento = {
    get: () => undefined,
    update: async () => undefined
  };
  assert.deepEqual(createWorkspacePersistence(storage).load(), {
    comments: [],
    overall: "",
    includeAiGenerated: true
  });
});

test("emergency reset deletes the workspace key without reading corrupted data", async () => {
  let update: { key: string; value: unknown } | undefined;
  const storage: WorkspaceMemento = {
    get: () => { throw new Error("corrupted value must not be read"); },
    update: async (key, value) => { update = { key, value }; }
  };

  await resetWorkspaceData(storage);
  assert.deepEqual(update, { key: STORAGE_KEY, value: undefined });
});
