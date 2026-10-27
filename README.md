# Review Relay

Review Relay turns VS Code comments into a live review channel between you and local coding agents.

Add comments to code with VS Code's native comment UI. Agents can read them, reply in the same threads, add their own comments, and navigate your editor through a loopback-only API and bundled CLI. For agents running in containers or without local access, copy the review as Markdown instead.

## Getting started

1. Install **Review Relay** from the VS Code Marketplace.
2. Open a project and select a line or range.
3. Run **Review Relay: Add Comment** from the Command Palette or editor context menu.
4. Open the Review Relay icon in the Activity Bar to add an overall review and copy agent instructions.

Review Relay's **Comments** tree groups comments by file and thread. Click a row to open its location in the editor. Hover over a thread or comment for **Copy Comment ID** and **Delete Comment**, or use its right-click menu. Deleting a thread removes all replies; deleting a reply preserves the rest of the thread. These actions work even when the file has been moved or deleted.

Inline comments also remain available through VS Code's native Comments UI. Use **Resolve** in a thread's title bar when you are done with it (**Reopen** brings it back). Resolved threads fold away, use VS Code's native resolved state (so the Comments panel's resolved filter applies), and are skipped by agents and the Markdown export. Any new reply reopens a thread.

## Keyboard commands

These commands act on the thread covering the active editor's cursor line, so they can be bound to keys. When several threads (or comments) qualify, a numbered quick pick chooses one.

| Command | Action |
| --- | --- |
| `reviewRelay.addComment` | Add a thread on the current line or selection |
| `reviewRelay.replyAtCursor` | Open the thread and put the focus in its reply editor |
| `reviewRelay.editAtCursor` | Edit a comment of the thread |
| `reviewRelay.deleteCommentAtCursor` | Delete a comment, after confirmation (deleting the first comment deletes the thread) |
| `reviewRelay.deleteThreadAtCursor` | Delete the whole thread, after confirmation |
| `reviewRelay.toggleResolveAtCursor` | Resolve the thread, or reopen a resolved one |
| `reviewRelay.toggleThreadAtCursor` | Show or hide the thread |

`reviewRelay.replyComment`, `reviewRelay.editComment`, and `reviewRelay.deleteComment` behave the same way when run without the comment-widget argument. The `reviewRelay.cursorOnThread` context key is true while the cursor is on a thread, for use in keybinding `when` clauses:

```json
{ "key": "ctrl+k r", "command": "reviewRelay.replyAtCursor", "when": "editorTextFocus && reviewRelay.cursorOnThread" }
```

VS Code anchors a thread on its last line and has no stable API to focus a reply editor, so **Reply** briefly moves the cursor to that line to focus it. If another thread ending on the same line could take the focus instead, the reply is typed in an input box.

## Connect a coding agent

Use **Copy Agent Instructions** in the **Review** view and paste the result into your agent chat. The instructions contain the current workspace, connection details, complete interface, and ready-to-run commands.

Review Relay includes a dependency-free CLI for macOS, Linux, and Windows. In remote workspaces, the extension and its loopback server run in the workspace host so native comments work in the remote editor. Copied agent instructions pass the workspace-local endpoint explicitly to the CLI. VS Code also provides a forwarded endpoint for tools running on the local UI host.

Agents can:

- Read the overall review and all inline threads
- Add and reply to comments
- Resolve and reopen threads when asked, and list only unresolved ones
- Navigate VS Code to a comment or source location
- Delete comments when explicitly requested

If an agent cannot access the host loopback interface or filesystem, use **Copy as Markdown** in the **Review** view. The export includes the complete conversation, including AI replies.

## Local and safe by default

- The API listens only on `127.0.0.1`.
- Browser-origin requests are rejected.
- API, UI, and persisted data use the same strict domain validation.
- Document URIs are parsed with VS Code-compatible semantics.
- No review data is sent to an external service by this extension.

If saved workspace data is corrupted, Review Relay stops before rendering it and shows the validation error. **Reset Project Data** removes only Review Relay's opaque state for that workspace and reloads the window.

## CLI and API

The copied Agent Instructions are the recommended reference because they include the live executable path and the endpoint appropriate for the CLI environment. The core CLI commands are:

```text
review-relay comments list [--unresolved]
review-relay comments add --uri URI --line N --body TEXT
review-relay comments reply COMMENT_ID --uri URI --line N [--end-line N] --body TEXT
review-relay comments resolve COMMENT_ID
review-relay comments unresolve COMMENT_ID
review-relay comments remove COMMENT_ID
review-relay comments clear
review-relay navigate --comment COMMENT_ID
```

The HTTP API exposes the corresponding `/health`, `/v1/comments` (`?resolved=false` for open threads only), `/v1/comments/:id/replies`, `/v1/comments/:id/resolved` (PUT `{ "resolved": true }`), and `/v1/navigate` resources. Line numbers are zero-based.

## Development

```bash
npm install
npm test
npm run build
```

Press F5 in VS Code to launch an Extension Development Host. `npm run package` builds the cross-platform CLIs and creates a VSIX.

Each reply must specify the current document URI and start line. The entire thread moves to that location, including across file renames. End line defaults to the start line.
