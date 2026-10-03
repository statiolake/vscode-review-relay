import assert from "node:assert/strict";
import test from "node:test";
import { createAgentInstructions } from "../src/agentInstructions";

test("local instructions use only workspace-discovered CLI connections", () => {
  const instructions = createAgentInstructions({
    endpoint: "http://127.0.0.1:49123",
    cliPath: "/extension/bin/darwin-arm64/review-relay",
    workspaceFolders: [{ uri: "file:///repo", localPath: "/repo" }]
  });

  assert.doesNotMatch(instructions, /127\.0\.0\.1|http:|--endpoint|curl|HTTP interface/);
  assert.match(instructions, /file:\/\/\/repo/);
  assert.match(instructions, /--workspace "\/repo"/);
  assert.match(instructions, /\/extension\/bin\/darwin-arm64\/review-relay/);
  assert.match(instructions, /"overall": string/);
  assert.match(instructions, /comments reply COMMENT_ID --uri CURRENT_DOCUMENT_URI --line 12/);
  assert.match(instructions, /zero-based and inclusive/);
  assert.match(instructions, /Do not delete comments unless the user explicitly asks/);
  assert.match(instructions, /remainingComments/);
  assert.match(instructions, /replies are never nested/);
  assert.match(instructions, /Before every reply/);
  assert.match(instructions, /outside the sandbox/);
});

test("remote workspaces use the CLI with an explicit workspace endpoint", () => {
  const instructions = createAgentInstructions({
    endpoint: "http://127.0.0.1:49123",
    cliEndpoint: "http://127.0.0.1:49124",
    cliPath: "/extension/bin/linux-amd64/review-relay",
    workspaceFolders: [{
      uri: "vscode-remote://dev-container%2Brepro/workspaces/repro"
    }]
  });

  assert.match(instructions, /Endpoint: http:\/\/127\.0\.0\.1:49123/);
  assert.match(instructions, /CLI endpoint: http:\/\/127\.0\.0\.1:49124/);
  assert.match(instructions, /CLI executable: \/extension\/bin\/linux-amd64\/review-relay/);
  assert.match(instructions, /--endpoint http:\/\/127\.0\.0\.1:49124 comments list/);
  assert.doesNotMatch(instructions, /--workspace/);
  assert.match(instructions, /vscode-remote:\/\/dev-container/);
  assert.match(instructions, /curl -fsS http:\/\/127\.0\.0\.1:49123\/health/);
});
