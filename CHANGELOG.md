# Changelog

## Unreleased

- The Neovim plugin carries the core prebuilt for every platform the VSIX ships (macOS, Linux and Windows; x86_64 and arm64) in `bin/`, committed, and runs the one for its platform: installing it (lazy.nvim, or copying its directory) needs no build step, Go, curl or network. `build.lua` and the GitHub release of the cores are gone. On another platform the plugin says which ones it ships.
- `scripts/build-bins.sh` rebuilds `bin/` reproducibly (`npm run build:cli` / `build:cli:all` run it); `.github/workflows/bin.yml` commits a rebuilt `bin/` to `main` when the core changes, and `bin-check.yml` fails a pull request whose `bin/` does not match its source.

## 0.5.0

- The review has a core of its own in this repository: `review-relay`, one Go binary (bundled per platform in `bin/`) that runs the review's loopback server, `review-relay attach` for the editors, and the agent CLI. Each workspace folder attaches to its review; comments, replies, resolve, the overall comment and the agent instructions all go through it, so a review open in VS Code shows in Neovim and the other way round.
- Review Relay is comments only: no diff mode, no reviewed marks, no viewer window. Diffs are Incremental Diff's, and the standalone review-relay viewer is a separate product with its own reviews.
- The bundled CLI's `comments` commands take `--path` (relative to the workspace root) instead of `--uri`. `review-relay serve` runs a review with no editor.
- Reviews are stored in `<user config dir>/vscode-review-relay/workspaces/<hash>/`. A review kept in the workspace state by an earlier version is moved there once, with its ids; comments outside the workspace folders are dropped and counted. **Reset Project Data** is gone: a corrupted file is named, to move away.
- Comments belong to files inside the workspace's file folders; the overall comment is the first folder's.
- A Neovim plugin in the same repository (`lua/`, `plugin/`): threads on buffer lines, a panel, a composer, drawn as cards in DevHub's GUI and as virt_lines elsewhere. See the README.
- The Neovim plugin's `build.lua` downloads the core from the GitHub release (`review-relay-<os>-<arch>.tar.gz`, checked against `SHA256SUMS`), or builds it with Go when the checkout is past the release or no prebuilt core fits. `review-relay version` prints the version.

## 0.4.3

- The **Comments** tree hides resolved threads, and files left with only resolved threads. Reopening a thread brings it back.

## 0.4.1

- **Add Comment** (`reviewRelay.addComment`) opens VS Code's own new-thread widget on the current line or the selected lines (every line of a multi-cursor or block selection), with the focus in its input, instead of an input box. The thread is created when the comment is submitted; closing the widget leaves no empty thread. A thread already anchored on that line is shown or hidden instead, as with the gutter **+**.

## 0.4.0

- Add keyboard commands that act on the thread on the cursor line: reply (focusing the reply editor), edit, delete a comment, delete the thread, resolve or reopen, and show or hide. Several candidates are chosen from a numbered quick pick. `reviewRelay.cursorOnThread` reports whether the cursor is on a thread, and the reply, edit, and delete widget commands fall back to the cursor line when run without an argument.
- Let threads be resolved, as in the standalone Review Relay viewer: **Resolve** / **Reopen** in the thread title, a `resolved` flag on the root comment, `PUT /v1/comments/:id/resolved`, `comments resolve` / `comments unresolve`, and `comments list --unresolved` (`?resolved=false`). A new reply reopens a thread. Agents are told to skip resolved threads, and the Markdown export leaves them out.
- VS Code's native resolved state now follows this flag instead of who answered last; the thread title shows **Waiting for AI** or **Last response: AI** instead.

## 0.3.0

- Restore the Review Relay comment tree with direct deletion and ID copying, including comments whose files no longer exist. Show only replies beneath each root comment.
- Use workspace-discovered CLI connections in local agent instructions, preserving explicit endpoints for remote workspaces.
- Require a document URI for replies and move the entire conversation to the supplied URI and line range. Existing reply clients must add `uri` (CLI: `--uri`).

## 0.1.14

- Let the Overall Comment editor fill the available Review panel height and remove redundant Options guidance.

## 0.1.13

- Use VS Code's native resolved-comment state to distinguish human- and agent-last threads, and consolidate the Review controls into one panel.

## 0.1.12

- Run native comments in the remote workspace host and pass the remote API endpoint explicitly to the CLI.

## 0.1.11

- Use VS Code theme colors for the Options checkbox.

## 0.1.10

- Keep persisted comment ranges synchronized with VS Code's native thread positions and require a current line when agents reply so they can relocate a thread after whole-file edits.

## 0.1.9

- Keep the Review view focused on the overall comment and Markdown export.
- Move the thread filter and agent instructions into a dedicated Options view.

## 0.1.8

- Open a comment from its thread label while reserving the disclosure arrow for the flat conversation.
- Open and select comment locations atomically before expanding their native thread.

## 0.1.7

- Expand the native comment thread when selecting a comment in the Review Relay tree.
- Show one row per comment thread and expand it into a flat, ordered conversation.
- Copy root or reply comment IDs from the Review Relay tree and native comment UI.
- Distinguish AI-last threads and optionally filter the tree to threads awaiting human review.
- Move the thread filter next to the Comments view, shorten the overall-comment editor, and always include AI replies in Markdown exports.

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
