import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";
import { CommentStore } from "../src/store";

const api = {
  EventEmitter: class {
    private listeners: Array<() => void> = [];
    event = (listener: () => void) => {
      this.listeners.push(listener);
      return { dispose: () => { this.listeners = this.listeners.filter(item => item !== listener); } };
    };
    fire() { this.listeners.forEach(listener => listener()); }
    dispose() { this.listeners = []; }
  },
  TreeItem: class { constructor(public label: string, public collapsibleState = 0) {} },
  ThemeIcon: class { constructor(public id: string) {} },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  workspace: { asRelativePath: (uri: { toString(): string }) => uri.toString() },
  Uri: { parse: (value: string) => ({ toString: () => value }) },
  MarkdownString: class { constructor(public value: string) {} }
};
const loader = Module as unknown as { _load: (request: string, ...args: unknown[]) => unknown };
const originalLoad = loader._load;
let Tree: typeof import("../src/commentsTree").CommentsTreeProvider;
try {
  loader._load = (request, ...args) => request === "vscode" ? api : originalLoad(request, ...args);
  Tree = require("../src/commentsTree").CommentsTreeProvider;
} finally {
  loader._load = originalLoad;
}

test("keeps missing-file comments accessible and refreshes the tree after deletion", async () => {
  const store = new CommentStore({ load: () => ({ comments: [], overall: "Keep overall" }), save: async () => {} });
  const root = await store.add({ uri: "file:///nonexistent/moved-away.ts", line: 10, body: "Orphaned" });
  const reply = await store.reply(root.id, { uri: "file:///nonexistent/moved-away.ts", line: 10, body: "Reply" });
  const tree = new Tree(store);
  let refreshes = 0;
  tree.onDidChangeTreeData(() => refreshes++);
  try {
    const file = tree.getChildren()[0];
    const thread = tree.getChildren(file)[0];
    assert.deepEqual(thread, { kind: "thread", id: root.id });
    assert.equal(tree.getTreeItem(thread).contextValue, "reviewRelayComment");
    const items = tree.getChildren(thread);
    assert.deepEqual(items, [{ kind: "comment", id: reply!.id }]);
    assert.equal(tree.getTreeItem(items[0]).contextValue, "reviewRelayComment");
    assert.equal(tree.getTreeItem(thread).collapsibleState, api.TreeItemCollapsibleState.Collapsed);
    await store.remove(reply!.id);
    assert.deepEqual(tree.getChildren(thread), []);
    assert.equal(tree.getTreeItem(thread).collapsibleState, api.TreeItemCollapsibleState.None);
    await store.reply(root.id, { uri: "file:///nonexistent/moved-away.ts", line: 10, body: "Another reply" });
    await store.remove(root.id);
    assert.deepEqual(tree.getChildren(), []);
    assert.equal(refreshes, 3);
    assert.equal(store.getOverall(), "Keep overall");
  } finally {
    tree.dispose();
  }
});
