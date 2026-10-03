# Review Relay

Review Relay turns VS Code comments into a live review channel between you and local coding agents.

Add comments to code with VS Code's native comment UI. Agents can read them, reply in the same threads, add their own comments, and navigate your editor through a loopback-only API and bundled CLI. For agents running in containers or without local access, copy the review as Markdown instead.

## Getting started

1. Install **Review Relay** from the VS Code Marketplace.
2. Open a project and select a line or range.
3. Run **Review Relay: Add Comment** from the Command Palette or editor context menu.
4. Open the Review Relay icon in the Activity Bar to add an overall review and copy agent instructions.

Review Relay's **Comments** tree groups comments by file and thread. Click a row to open its location in the editor. Hover over a thread or comment for **Copy Comment ID** and **Delete Comment**, or use its right-click menu. Deleting a thread removes all replies; deleting a reply preserves the rest of the thread. These actions work even when the file has been moved or deleted.

Inline comments also remain available through VS Code's native Comments UI.

## Connect a coding agent

Use **Copy Agent Instructions** in the **Review** view and paste the result into your agent chat. The instructions contain the current workspace, connection details, complete interface, and ready-to-run commands.

Review Relay includes a dependency-free CLI for macOS, Linux, and Windows. In remote workspaces, the extension and its loopback server run in the workspace host so native comments work in the remote editor. Copied agent instructions pass the workspace-local endpoint explicitly to the CLI. VS Code also provides a forwarded endpoint for tools running on the local UI host.

Agents can:

- Read the overall review and all inline threads
- Add and reply to comments
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
review-relay comments list
review-relay comments add --uri URI --line N --body TEXT
review-relay comments reply COMMENT_ID --uri URI --line N [--end-line N] --body TEXT
review-relay comments remove COMMENT_ID
review-relay comments clear
review-relay navigate --comment COMMENT_ID
```

The HTTP API exposes the corresponding `/health`, `/v1/comments`, `/v1/comments/:id/replies`, and `/v1/navigate` resources. Line numbers are zero-based.

## Development

```bash
npm install
npm test
npm run build
```

Press F5 in VS Code to launch an Extension Development Host. `npm run package` builds the cross-platform CLIs and creates a VSIX.

Each reply must specify the current document URI and start line. The entire thread moves to that location, including across file renames. End line defaults to the start line.
