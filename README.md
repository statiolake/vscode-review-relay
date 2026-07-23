# Review Relay

Review Relay is a shared, live review-comment channel between a human in VS Code and local AI tooling. VS Code remains the diff/editor UI and language-aware navigation surface; the extension owns one comment store and exposes it both through VS Code's native Comments UI and a loopback-only HTTP API.

The Review Relay Activity Bar contains both the overall review controls and a dedicated comment tree grouped by file and source location. Selecting a location or comment navigates to it without relying on VS Code's built-in Comments view. **Copy as Markdown** combines the overall text, inline source snippets, and review comments for agents that cannot reach the local API. **Include AI-generated comments** controls whether agent-authored comments are included in that export. The same view can copy the live Agent Instructions for agents that can use the bundled CLI.

## Try it

```bash
npm install
npm run build
```

Open this directory in VS Code and run the `Extension` launch configuration, or press F5. Select code and run **Review Relay: Add Comment**. The status bar shows that the API is running; click it to copy the endpoint.

To connect an AI agent, run **Review Relay: Copy Agent Instructions** from the Command Palette and paste the copied Markdown into the agent chat. It contains the live endpoint, open workspace URIs, interface contract, safety rules, and ready-to-run CLI examples.

The extension bundles a dependency-free Go CLI for the current OS and architecture. Agent instructions include its absolute path and workspace-specific commands, so agents do not need Node.js, curl, or jq. Run `npm run build:cli:all` before packaging a cross-platform VSIX.

Each VS Code window binds an available random loopback port and registers its endpoint against its workspace folders. The CLI discovers the right window from `--workspace PATH`, or from its current directory when that option is omitted. This allows multiple projects to use Review Relay concurrently without coordinating port numbers. `--endpoint URL` remains available as an explicit override.

```bash
# Read all comments
review-relay --workspace /absolute/path/to/project comments list

# Add an AI comment (line numbers are zero-based; uri is a VS Code URI)
review-relay --workspace /absolute/path/to/project comments add \
  --uri file:///absolute/path/src/app.ts --line 12 \
  --body 'Should this error be propagated?' --author Codex

# Open a comment in VS Code
review-relay --workspace /absolute/path/to/project navigate --comment COMMENT_ID

# Filter, remove one, or clear all
review-relay comments list --uri file:///absolute/path/src/app.ts
review-relay comments remove COMMENT_ID
review-relay comments clear
```

Comments persist in VS Code workspace storage and updates from either side immediately redraw both the Review Relay comment tree and native comment threads. Comment-list responses include the overall review, and deletion responses report how many inline comments remain. The server binds only to `127.0.0.1`, rejects browser-origin requests, requires JSON for writes, and caps request bodies at 64 KiB.

## API

- `GET /health`
- `GET /v1/comments[?uri=...]` returns `{ overall, comments }`
- `POST /v1/comments` with `{ uri, line, endLine?, body, author?, source? }`
- `POST /v1/navigate` with `{ commentId }` or `{ uri, line, endLine? }`
- `DELETE /v1/comments/:id`
- `DELETE /v1/comments`

This MVP deliberately uses a small HTTP resource API rather than coupling agents to VS Code commands. A future CLI or MCP server can be a thin client over the same API without moving comment ownership out of the extension.
