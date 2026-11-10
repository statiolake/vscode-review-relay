# Review Relay

Review Relay turns editor comments into a live review channel between you and local coding agents — in VS Code, and in Neovim (with DevHub's GUI when it draws Neovim).

The review is kept by Review Relay's core, a small native binary bundled with the extension and the plugin (no Go or Node needed to use them): one server per workspace keeps, validates and stores the threads and tells every client of a change — this extension, the Neovim plugin below, and agents through its CLI. Both editors are thin frontends of it; see [docs/architecture.md](docs/architecture.md) for why.

Review Relay is comments only. Diffs are [Incremental Diff](https://github.com/statiolake/vscode-incremental-diff)'s job, and a diff that shows a file of the work tree shows its threads too. The standalone [review-relay](https://github.com/statiolake/review-relay) viewer is a separate product with its own reviews.

Add comments to code with VS Code's native comment UI. Agents can read them, reply in the same threads, add their own comments, and navigate your editor through a loopback-only API and bundled CLI. For agents running in containers or without local access, copy the review as Markdown instead.

## Getting started

1. Install **Review Relay** from the VS Code Marketplace.
2. Open a project and select a line or range.
3. Click the **+** in the gutter, or run **Review Relay: Add Comment** from the Command Palette or editor context menu, type the comment, and press **Add Comment** (Ctrl/Cmd+Enter).
4. Open the Review Relay icon in the Activity Bar to add an overall review and copy agent instructions.

Review Relay's **Comments** tree groups comments by file and thread. Click a row to open its location in the editor. Resolved threads are hidden from the tree. Hover over a thread or comment for **Copy Comment ID** and **Delete Comment**, or use its right-click menu. Deleting a thread removes all replies; deleting a reply preserves the rest of the thread. These actions work even when the file has been moved or deleted.

Inline comments also remain available through VS Code's native Comments UI. Use **Resolve** in a thread's title bar when you are done with it (**Reopen** brings it back). Resolved threads fold away, use VS Code's native resolved state (so the Comments panel's resolved filter applies), and are skipped by agents and the Markdown export. Any new reply reopens a thread.

## Keyboard commands

These commands act on the thread covering the active editor's cursor line, so they can be bound to keys. When several threads (or comments) qualify, a numbered quick pick chooses one.

| Command | Action |
| --- | --- |
| `reviewRelay.addComment` | Open VS Code's new-thread widget (as the gutter **+** does) on the current line or the selected lines, with the focus in its input |
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

Review Relay includes a dependency-free CLI for macOS, Linux, and Windows: the core's own executable. It finds the running review from the current directory (or `--workspace`), so it keeps working when the editor restarts. In remote workspaces, the extension and its loopback server run in the workspace host so native comments work in the remote editor.

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

Reviews are stored outside the workspace, in `<user config dir>/vscode-review-relay/workspaces/<hash>/state.json`. A review kept in VS Code's workspace state by an earlier version is moved there once, ids kept; comments on files outside the workspace folders are dropped (and counted). A review the editors kept in standalone review-relay's directory (`<user config dir>/review-relay/workspaces/<hash>/`, during the unreleased 0.5 development) is copied over the first time the workspace is opened. If the stored review is corrupted, Review Relay refuses to open it and names the file to move away.

Each file workspace folder is one review; comments belong to files inside the folders (not untitled documents or other schemes), and the overall comment is the first folder's.

## CLI and API

The bundled CLI is the core's `review-relay` executable (`bin/<os>-<arch>/` in the extension or the plugin; not the standalone viewer of the same name). The copied Agent Instructions are the recommended reference because they include its path. The commands are:

```text
review-relay comments list [--path PATH] [--unresolved]
review-relay comments add --path PATH --line N [--end-line N] --body TEXT
review-relay comments reply COMMENT_ID --path PATH --line N [--end-line N] --body TEXT
review-relay comments resolve COMMENT_ID
review-relay comments unresolve COMMENT_ID
review-relay comments remove COMMENT_ID
review-relay comments clear
review-relay navigate --comment COMMENT_ID
review-relay navigate --path PATH --line N [--end-line N]
review-relay health
review-relay serve [--workspace PATH]
```

Paths are relative to the workspace root and line numbers are zero-based. A reply moves the whole thread to its location and reopens it. `navigate` shows the comment or location in every editor that has the review open. `serve` runs a review with no editor, until interrupted. The HTTP API (`/health` and `/v1/…`) listens only on `127.0.0.1` and refuses browser origins and foreign `Host` headers; the instructions list it, and [docs/architecture.md](docs/architecture.md) lists everything the editors use. (Up to 0.4 the commands took `--uri`; they take `--path` now.)

## Neovim

The same repository is a Neovim plugin: `lua/review_relay` and `plugin/review_relay.lua`, over the same core. With [lazy.nvim](https://github.com/folke/lazy.nvim):

```lua
{
  'statiolake/vscode-review-relay',
  cmd = 'ReviewRelay',
  event = 'VeryLazy', -- join a review already running for the directory
  keys = {
    { '<Leader>R', '<cmd>ReviewRelay<CR>', desc = 'Review Relay: panel' },
    { '<Leader>rc', ':ReviewRelay comment<CR>', mode = { 'n', 'x' }, desc = 'Review Relay: comment' },
  },
  -- opts = { ... }, -- require('review_relay').setup(opts); see below
}
```

The plugin carries the core prebuilt for every platform the VSIX ships (macOS, Linux and Windows; x86_64 and arm64) in `bin/<os>-<arch>/review-relay`, committed to the repository, and runs the one for the platform it is on. Installing it is only getting the files: lazy.nvim needs no `build`, and copying the plugin's directory to another machine (an SSH host, say) is enough there too, with no Go, compiler or network. On another platform it says which ones it has; build a core with `scripts/build-bins.sh` from a checkout, or point `cmd` (below) at one.

- `:ReviewRelay` opens the panel — the files with threads, the threads, the overall comment — joining the review running for the current directory or starting one that stops when Neovim exits. In it: `j`/`k`, `<CR>` open a file or thread (a directory folds, the filter turns), `r` reply, `s` resolve / reopen, `f` filter, `o` overall comment, `R` refresh, `q` close.
- `:ReviewRelay comment` comments on the cursor line, or on a visual range. The comment is written in a markdown buffer in a float under the lines: `<C-s>` or `:w` sends, `q` or `:q` drops it; leaving it keeps the draft.
- On a thread's lines, `r` replies and `s` resolves or reopens (elsewhere they are `r` and `s`). `]r` / `[r` go to the next / previous open thread, across files. `:ReviewRelay reply | resolve | edit | delete | overall | next | prev | refresh | stop` do the same as commands.
- A thread belongs to its file's buffer: it shows in every window on it, a window in diff mode too, follows your edits (and tells the review where its lines went), and a reply or an agent's comment shows at once. A buffer that is no file of the work tree (an old revision's scratch buffer) takes no comments, and says so.
- In DevHub's GUI (with [devhub.nvim](https://github.com/statiolake/devhub.nvim)), a thread is a card under its last line — the comments in markdown, who wrote them, Reply and Resolve with their keys — and the panel is drawn. Elsewhere a thread is virt_lines under its last line and a sign, and the panel is the same buffer as text; everything works the same.

```lua
require('review_relay').setup {
  cmd = nil,            -- the core's executable; nil: bin/<os>-<arch>/review-relay of the plugin
  auto_attach = true,   -- join a running review at startup and on :cd (never starts one)
  author = nil,         -- your name; nil: git config user.name
  width = 54,           -- the panel's width
  thread_keys = { reply = 'r', resolve = 's' }, -- on a thread's lines; false: none
  keys = { next = ']r', prev = '[r' },           -- in the review's file buffers; false: none
  notify = true,        -- a notification when the agent answers
  colors = { agent = 'Function', human = 'DiagnosticInfo', waiting = 'DiagnosticWarn', resolved = 'Comment', ok = 'DiagnosticOk' },
}
```

Neovim 0.9 or later.

## Development

```bash
npm install
npm test        # builds the core into bin/, the extension's tests, and tests/nvim (headless Neovim)
go test ./...   # the core
npm run build
```

Building needs Go: `npm run build:cli` builds the core (`cmd/review-relay`) for this platform into `bin/`, and `npm run build:cli:all` (`scripts/build-bins.sh`) for every platform the VSIX ships; `scripts/build-bins.sh --check` fails unless `bin/` is what the source builds. Press F5 in VS Code to launch an Extension Development Host. `npm run package` builds the cross-platform binaries and creates a VSIX. `tests/nvim/run.sh` (`NVIM=…` for another Neovim) runs the Neovim plugin against the core in `bin/`.

`bin/` is committed: it is what installs run. After changing the core (`cmd/`, `internal/`, `go.mod`, `go.sum`), run `scripts/build-bins.sh` and commit `bin/` with the change. The build is reproducible (no cgo, `-trimpath`, no VCS stamp, stripped, one pinned Go release that Go fetches if yours differs), so the same source gives the same bytes on any machine. On `main`, `.github/workflows/bin.yml` does it for you: a push that changes the core and not `bin/` gets a bot commit with the rebuilt `bin/`. `.github/workflows/bin-check.yml` fails a pull request (or a push touching `bin/`) whose `bin/` is not what its source builds. With lazy.nvim on a checkout of your own (`dir = …`), `build = 'scripts/build-bins.sh host'` rebuilds the core there on each update.
