# Changelog

## Unreleased

- Add a dedicated Review Relay comment tree grouped by file and source location.
- Include the overall review in live comment-list responses.
- Report the number of remaining comments after deletion.

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
