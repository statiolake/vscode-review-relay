import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";
import { CommentStore } from "../src/store";

interface FakeThread {
  uri: { toString(): string };
  range: { start: { line: number }; end: { line: number } };
  comments: unknown[];
  disposed: boolean;
  state?: number;
  label?: string;
  contextValue?: string;
  collapsibleState?: number;
  dispose(): void;
}

const threads: FakeThread[] = [];
const executed: string[] = [];
const executedArgs: unknown[] = [];
const inputs: string[] = [];
let activeTextEditor: unknown;
const api = {
  comments: { createCommentController: () => ({
    createCommentThread: (uri: { toString(): string }, range: FakeThread["range"], comments: unknown[]) => {
      const thread: FakeThread = { uri, range, comments, disposed: false, dispose() { this.disposed = true; } };
      threads.push(thread);
      return thread;
    },
    dispose() {}
  }) },
  commands: { executeCommand: async (id: string, ...args: unknown[]) => { executed.push(id); executedArgs.push(args); } },
  window: { showInputBox: async () => inputs.shift(), get activeTextEditor() { return activeTextEditor; } },
  workspace: { onDidChangeTextDocument: () => ({ dispose() {} }) },
  Uri: { parse: (value: string) => ({ toString: () => value }) },
  Range: class {
    start: { line: number; character: number };
    end: { line: number; character: number };
    constructor(a: number, b: number, c: number, d: number) {
      this.start = { line: a, character: b }; this.end = { line: c, character: d };
    }
  },
  Selection: class {
    constructor(public anchorLine: number, _a: number, public activeLine: number, _b: number) {}
  },
  MarkdownString: class { constructor(public value: string) {} },
  CommentMode: { Preview: 0, Editing: 1 },
  CommentThreadState: { Unresolved: 0, Resolved: 1 },
  CommentThreadCollapsibleState: { Collapsed: 0, Expanded: 1 }
};
const loader = Module as unknown as { _load: (request: string, ...args: unknown[]) => unknown };
const original = loader._load;
let Comments: typeof import("../src/vscodeComments").VsCodeComments;
let selectedLines: typeof import("../src/vscodeComments").selectedLines;
try {
  loader._load = (request, ...args) => request === "vscode" ? api : original(request, ...args);
  ({ VsCodeComments: Comments, selectedLines } = require("../src/vscodeComments"));
} finally { loader._load = original; }

function emptyStore(): CommentStore {
  return new CommentStore({ load: () => ({ overall: "", comments: [] }), save: async () => {} });
}

function fakeEditor(uri: string) {
  const editor = {
    document: { uri: { toString: () => uri } },
    selection: undefined as unknown,
    selections: ["original"] as unknown[],
    history: [] as unknown[]
  };
  return new Proxy(editor, {
    set(target, key, value) {
      if (key === "selection" || key === "selections") target.history.push(value);
      return Reflect.set(target, key, value);
    }
  });
}

test("recreates native threads at the new URI when a reply relocates the conversation", async () => {
  threads.length = 0;
  const store = emptyStore();
  const root = await store.add({ uri: "file:///gone.ts", line: 0, body: "Move me" });
  const adapter = new Comments(store);
  try {
    const old = threads[0];
    await store.reply(root.id, { uri: "file:///new.ts", line: 4, endLine: 6, body: "Moved" });
    assert.equal(old.disposed, true);
    assert.equal(threads[1].uri.toString(), "file:///new.ts");
    assert.equal(store.thread(root.id).length, 2);
    assert.ok(store.thread(root.id).every(comment => comment.uri === "file:///new.ts" && comment.range.start.line === 4));
  } finally { adapter.dispose(); }
});

test("mirrors the resolved flag into the native thread state", async () => {
  threads.length = 0;
  const store = emptyStore();
  const root = await store.add({ uri: "file:///a.ts", line: 0, body: "Check", source: "human" });
  const adapter = new Comments(store);
  try {
    const thread = threads[0];
    assert.deepEqual([thread.state, thread.contextValue, thread.label], [0, "unresolved", "Waiting for AI"]);
    await store.reply(root.id, { uri: "file:///a.ts", line: 0, body: "Done" });
    assert.equal(thread.label, "Last response: AI");
    await store.setResolved(root.id, true);
    assert.deepEqual([thread.state, thread.contextValue, thread.label], [1, "resolved", "Resolved"]);
    adapter.toggleThread(root.id);
    assert.equal(thread.collapsibleState, 1);
    adapter.toggleThread(root.id);
    assert.equal(thread.collapsibleState, 0);
  } finally { adapter.dispose(); }
});

test("focuses a thread's reply editor from its anchor line and restores the selection", async () => {
  threads.length = 0;
  executed.length = 0;
  const store = emptyStore();
  const root = await store.add({ uri: "file:///a.ts", line: 2, endLine: 5, body: "Check" });
  const adapter = new Comments(store);
  try {
    const editor = fakeEditor("file:///a.ts");
    await adapter.focusReply(root.id, editor as never);
    assert.deepEqual(executed, ["workbench.action.focusCommentOnCurrentLine", "widgetNavigation.focusNext"]);
    const [anchor, restored] = editor.history as Array<{ activeLine?: number }>;
    assert.equal(anchor.activeLine, 5);
    assert.deepEqual(restored, ["original"]);
  } finally { adapter.dispose(); }
});

test("replies through an input box when an earlier thread shares the anchor line", async () => {
  threads.length = 0;
  executed.length = 0;
  const store = emptyStore();
  await store.add({ uri: "file:///a.ts", line: 3, body: "First" });
  const second = await store.add({ uri: "file:///a.ts", line: 3, body: "Second" });
  const adapter = new Comments(store);
  try {
    inputs.push("Answer");
    await adapter.focusReply(second.id, fakeEditor("file:///a.ts") as never);
    assert.deepEqual(executed, []);
    assert.deepEqual(store.thread(second.id).map(comment => [comment.body, comment.source]), [["Second", "agent"], ["Answer", "human"]]);
  } finally { adapter.dispose(); }
});

function selection(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
  return { start: { line: startLine, character: startCharacter }, end: { line: endLine, character: endCharacter } };
}

test("counts the lines a selection covers as VS Code does for a command on the selected lines", () => {
  assert.deepEqual(selectedLines([selection(2, 4, 2, 4)]), { start: 2, end: 2 });
  assert.deepEqual(selectedLines([selection(2, 0, 5, 3)]), { start: 2, end: 5 });
  // a selection ending at the start of a line leaves that line out
  assert.deepEqual(selectedLines([selection(2, 0, 5, 0)]), { start: 2, end: 4 });
  // a visual block: one selection per line
  assert.deepEqual(selectedLines([selection(4, 1, 4, 3), selection(2, 1, 2, 3), selection(3, 1, 3, 3)]), { start: 2, end: 4 });
});

test("adds a thread through VS Code's own new-thread widget, never an input box", async () => {
  threads.length = 0;
  const adapter = new Comments(emptyStore());
  try {
    const lines = ["zero", "one", "two", "three"];
    const editorOn = (...selections: ReturnType<typeof selection>[]) => ({
      document: { uri: { toString: () => "file:///a.ts" }, lineAt: (line: number) => ({ text: lines[line] }) },
      selection: selections[0],
      selections
    });
    executed.length = 0;
    executedArgs.length = 0;
    activeTextEditor = editorOn(selection(1, 2, 1, 2));
    await adapter.addAtSelection();
    assert.deepEqual(executed, ["workbench.action.addComment"]);
    assert.deepEqual(executedArgs, [[]]);

    executed.length = 0;
    executedArgs.length = 0;
    activeTextEditor = editorOn(selection(1, 0, 3, 0), selection(2, 0, 2, 1));
    await adapter.addAtSelection();
    assert.deepEqual(executed, ["workbench.action.addComment"]);
    assert.deepEqual(executedArgs, [[{ range: { startLineNumber: 2, startColumn: 1, endLineNumber: 3, endColumn: 4 } }]]);
    assert.equal(inputs.length, 0);
    assert.equal(threads.length, 0);
  } finally {
    activeTextEditor = undefined;
    adapter.dispose();
  }
});
