# Review Relay

Review Relay turns VS Code comments into a live review channel between you and local coding agents.

Add comments to code with VS Code's native comment UI. Agents can read them, reply in the same threads, add their own comments, and navigate your editor through a loopback-only API and bundled CLI. For agents running in containers or without local access, copy the review as Markdown instead.

## Getting started

1. Install **Review Relay** from the VS Code Marketplace.
2. Open a project and select a line or range.
3. Run **Review Relay: Add Comment** from the Command Palette or editor context menu.
4. Open the Review Relay icon in the Activity Bar to browse comments and add an overall review.

Comments are also shown inline through VS Code's native Comments UI. You can reply to, edit, or delete any Review Relay comment there.

## Connect a coding agent

Use **Copy Agent Instructions** in **Options** and paste the result into your agent chat. The instructions contain the current workspace, connection details, complete interface, and ready-to-run commands.

Review Relay includes a dependency-free CLI for macOS, Linux, and Windows. The extension and its loopback server run on the local UI host, including when VS Code is connected to a Dev Container, SSH host, or WSL workspace. Local workspaces are discovered from their path; copied agent instructions use the explicit local endpoint for remote workspaces.

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

The copied Agent Instructions are the recommended reference because they include the live executable path and endpoint. The core CLI commands are:

```text
review-relay comments list
review-relay comments add --uri URI --line N --body TEXT
review-relay comments reply COMMENT_ID --line N [--end-line N] --body TEXT
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
