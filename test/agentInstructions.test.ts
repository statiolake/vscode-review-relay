import assert from "node:assert/strict";
import test from "node:test";
import { createAgentInstructions } from "../src/agentInstructions";

test("agent instructions contain the live endpoint, workspace and complete interface", () => {
  const instructions = createAgentInstructions({
    endpoint: "http://127.0.0.1:49123",
    cliPath: "/extension/bin/darwin-arm64/review-relay",
    workspaceFolders: [{ uri: "file:///repo", path: "/repo" }]
  });

  assert.match(instructions, /http:\/\/127\.0\.0\.1:49123/);
  assert.match(instructions, /file:\/\/\/repo/);
  assert.match(instructions, /--workspace "\/repo"/);
  assert.match(instructions, /\/extension\/bin\/darwin-arm64\/review-relay/);
  assert.match(instructions, /GET \/v1\/comments/);
  assert.match(instructions, /POST \/v1\/comments/);
  assert.match(instructions, /POST \/v1\/navigate/);
  assert.match(instructions, /DELETE \/v1\/comments\/<id>/);
  assert.match(instructions, /zero-based and inclusive/);
  assert.match(instructions, /Do not delete comments unless the user explicitly asks/);
});
