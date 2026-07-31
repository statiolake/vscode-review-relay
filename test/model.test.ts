import assert from "node:assert/strict";
import test from "node:test";
import {
  validateCreateComment,
  validateCreateReply,
  validateNavigate,
  validateReviewRelayState
} from "../src/model";

const validComment = {
  id: "00000000-0000-4000-8000-000000000001",
  uri: "file:///repo/src/app.ts",
  range: {
    start: { line: 3, character: 0 },
    end: { line: 4, character: 0 }
  },
  body: "Check this",
  author: "Human",
  source: "human" as const,
  createdAt: "2026-07-27T00:00:00.000Z"
};

test("accepts document URIs that can be used as absolute VS Code URIs", () => {
  assert.equal(validateCreateComment({
    uri: "file:///repo/%E6%97%A5%E6%9C%AC%E8%AA%9E.ts",
    line: 0,
    body: "Check this"
  }).uri, "file:///repo/%E6%97%A5%E6%9C%AC%E8%AA%9E.ts");

  const navigation = validateNavigate({
    uri: "untitled:Untitled-1",
    line: 0
  });
  assert.ok("uri" in navigation);
  assert.equal(navigation.uri, "untitled:Untitled-1");
});

test("rejects malformed, relative, and ambiguous document URIs", () => {
  for (const uri of [
    "",
    "not-a-uri",
    "/repo/app.ts",
    "file:///repo/bad path.ts",
    "file:///repo/%ZZ.ts",
    "file:\\repo\\app.ts"
  ]) {
    assert.throws(() => validateCreateComment({ uri, line: 0, body: "Check this" }), uri);
  }
});

test("strictly rejects unknown input fields and invalid ranges", () => {
  assert.throws(() => validateCreateComment({
    uri: "file:///repo/app.ts",
    line: 4,
    endLine: 3,
    body: "Check this"
  }));
  assert.throws(() => validateCreateComment({
    uri: "file:///repo/app.ts",
    line: 0,
    body: "Check this",
    unexpected: true
  }));
  assert.throws(() => validateCreateReply({ body: "Reply" }));
  assert.deepEqual(validateCreateReply({ line: 4, body: "Reply" }), {
    line: 4,
    body: "Reply"
  });
  assert.throws(() => validateCreateReply({ line: 4, endLine: 3, body: "Reply" }));
});

test("validates the complete persisted state including thread invariants", () => {
  const valid = {
    comments: [validComment],
    overall: "",
    showAgentLastOnly: false
  };
  assert.deepEqual(validateReviewRelayState(valid), valid);

  assert.throws(() => validateReviewRelayState({
    ...valid,
    comments: [{ ...validComment, uri: "invalid" }]
  }), /valid absolute VS Code document URI/);

  assert.throws(() => validateReviewRelayState({
    ...valid,
    comments: [{
      ...validComment,
      id: "00000000-0000-4000-8000-000000000002",
      parentId: "00000000-0000-4000-8000-000000000099"
    }]
  }), /Parent comment not found/);

  assert.throws(() => validateReviewRelayState({
    ...valid,
    comments: [validComment, { ...validComment }]
  }), /Duplicate comment id/);

  assert.throws(() => validateReviewRelayState({
    ...valid,
    unexpected: true
  }));
});

test("normalizes legacy nested replies into one ordered thread", () => {
  const firstReply = {
    ...validComment,
    id: "00000000-0000-4000-8000-000000000002",
    parentId: validComment.id,
    body: "First reply"
  };
  const nestedReply = {
    ...validComment,
    id: "00000000-0000-4000-8000-000000000003",
    parentId: firstReply.id,
    body: "Nested reply"
  };

  const state = validateReviewRelayState({
    comments: [validComment, firstReply, nestedReply],
    overall: "",
    includeAiGenerated: true
  });

  assert.equal(state.showAgentLastOnly, false);
  assert.equal("includeAiGenerated" in state, false);
  assert.deepEqual(state.comments.map(comment => comment.parentId), [
    undefined,
    validComment.id,
    validComment.id
  ]);
});
