# Changelog

## 0.1.6

- Run the loopback server in the local UI extension host so host-side agents can connect while VS Code uses a remote workspace.
- Use explicit endpoint instructions when remote workspace paths are unavailable on the UI host.

## 0.1.5

- Preserve comment drafts, Vim modes, and IME composition across unrelated live review updates.
- Keep overall-comment persistence from stealing focus or saving incomplete IME composition.

## 0.1.4

- Add threaded replies across VS Code, the Review Relay tree, HTTP API, and bundled CLI.
- Validate all comment inputs and persisted workspace state with strict domain schemas.
- Fail fast on corrupted state and offer a workspace-scoped emergency reset.

## 0.1.3

- Add a dedicated Review Relay comment tree grouped by file and source location.
- Include the overall review in live comment-list responses.
- Report the number of remaining comments after deletion.
- Keep deletion counts in CLI responses without showing extra VS Code notifications.

## 0.1.2

- Show the Add Comment action in VS Code's native new-comment editor.

## 0.1.1

- Run each VS Code window on an available random port and let the CLI discover it from the workspace path.
- Keep copy confirmations in VS Code notifications so the Review view does not shift.
- Tell agents to request fresh connection instructions after a VS Code restart.

## 0.1.0

- Share live review comments between VS Code and local agents over a loopback API.
- Bundle a dependency-free CLI for macOS, Linux, and Windows.
- Navigate VS Code from agents and show inline human and AI comments.
- Add an overall review view with Markdown export and copyable agent instructions.
