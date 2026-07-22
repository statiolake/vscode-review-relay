# Commentator

Commentator is an MVP VS Code extension for a shared, live review-comment channel between a human in VS Code and local AI tooling. VS Code remains the diff/editor UI and language-aware navigation surface; the extension owns one comment store and exposes it both through VS Code's native Comments UI and a loopback-only HTTP API.

## Try it

```bash
npm install
npm run build
```

Open this directory in VS Code and run the `Extension` launch configuration, or press F5. Select code and run **Commentator: Add Comment**. The status bar shows that the API is running; click it to copy the endpoint.

To connect an AI agent, run **Commentator: Copy Agent Instructions** from the Command Palette and paste the copied Markdown into the agent chat. It contains the live endpoint, open workspace URIs, interface contract, safety rules, and ready-to-run curl examples.

The default endpoint is `http://127.0.0.1:47658` and can be changed with `commentator.server.port`. Setting the port to `0` chooses a free port.

```bash
# Read all comments
curl -s http://127.0.0.1:47658/v1/comments

# Add an AI comment (line numbers are zero-based; uri is a VS Code URI)
curl -s -X POST http://127.0.0.1:47658/v1/comments \
  -H 'content-type: application/json' \
  -d '{"uri":"file:///absolute/path/src/app.ts","line":12,"body":"Should this error be propagated?","author":"Codex"}'

# Filter, remove one, or clear all
curl -s 'http://127.0.0.1:47658/v1/comments?uri=file%3A%2F%2F%2Fabsolute%2Fpath%2Fsrc%2Fapp.ts'
curl -s -X DELETE http://127.0.0.1:47658/v1/comments/COMMENT_ID
curl -s -X DELETE http://127.0.0.1:47658/v1/comments
```

Comments persist in VS Code workspace storage and updates from either side immediately redraw native comment threads. The server binds only to `127.0.0.1`, rejects browser-origin requests, requires JSON for writes, and caps request bodies at 64 KiB.

## API

- `GET /health`
- `GET /v1/comments[?uri=...]`
- `POST /v1/comments` with `{ uri, line, endLine?, body, author?, source? }`
- `DELETE /v1/comments/:id`
- `DELETE /v1/comments`

This MVP deliberately uses a small HTTP resource API rather than coupling agents to VS Code commands. A future CLI or MCP server can be a thin client over the same API without moving comment ownership out of the extension.
