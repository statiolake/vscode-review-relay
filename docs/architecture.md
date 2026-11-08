# Architecture: one core, thin frontends

Review Relay is a review shared between a person and coding agents: threads on
lines of a workspace's files, an overall comment, resolve / reopen, and a
live view of what the other side wrote. This repository holds all of it: the
**core** (`cmd/review-relay`, `internal/`, Go) and its two **frontends**, the
VS Code extension (`src/`) and the Neovim plugin (`lua/`, `plugin/`), which
DevHub's GUI draws when it hosts Neovim.

```
          agents ── review-relay comments … (CLI) ──┐
                                                    ▼
 VS Code ─ spawn ──▶ review-relay attach ─ HTTP ─▶ review server
 Neovim  ─ jobstart ▶ review-relay attach ─ HTTP ─▶  (one per workspace root:
                                                     store, validation, events)
```

## The core is comments, and only comments

The core is a review and nothing else: comment threads on lines of files, the
overall comment, resolve / reopen, their storage, the event stream that tells
every client of a change, and the agent CLI with the agent instructions. It
has no diff mode, no reviewed marks and no window. It does not run git or
read the work tree beyond counting a file's lines for `navigate`.

Diffing is another tool's job ([vscode-incremental-diff](https://github.com/statiolake/vscode-incremental-diff)),
and the two do not know each other. They meet in the editor only: a thread
belongs to its file's buffer (Neovim) or document (VS Code), so a diff view
that shows the work tree's file in that buffer or document shows its threads
too, with no convention between the two.

[review-relay](https://github.com/statiolake/review-relay) is a separate
product: a standalone viewer that merges review and diff in one window. It
has a review core of its own (where this one came from) and no editor
frontend depends on it.

## Why one Go binary

`review-relay` (`cmd/review-relay`) is the server, the frontends' `attach`
and the agent CLI in one executable, without cgo:

- Agents run it from a shell, so it must be a native command; the server and
  `attach` come with it at no cost, and one binary means one version on both
  ends of every pipe.
- It cross-compiles from anywhere, and nobody who installs the extension or
  the plugin needs Go or Node: the VSIX carries a build per platform in
  `bin/<os>-<arch>/`, and `build.lua` puts one at the same place for
  lazy.nvim. `build.lua` builds it from this checkout's source for now
  (needs Go); a prebuilt binary fetched per platform and checked by sha256
  replaces its `from_source` step and nothing else, since the frontends only
  look for the executable at that path.

## The pieces

- `internal/review`: the model and its rules (a reply moves its thread and
  reopens it; only roots resolve; ids, paths and lines validated), and the
  store that writes every change before announcing it.
- `internal/server`: one loopback HTTP API under `/v1/` for every client. It
  serves no page, so every browser `Origin` is refused, as is a foreign
  `Host` (DNS rebinding).
- `internal/session`: how a review is found. A running server writes a
  descriptor (`$TMPDIR/vscode-review-relay/sessions/<hash of root>.json`),
  created exclusively, so a root has one server. The CLI picks the deepest
  root containing its directory (or `--workspace`, or `--endpoint` /
  `REVIEW_RELAY_ENDPOINT`); `attach` looks up its root exactly.
- `internal/host`: runs one review. The **workspace root** of a directory is
  the top of its work tree (the nearest directory with a `.git` entry,
  worktrees and submodules included), else the directory. The review is
  stored outside the workspace, so it never ends up in a commit:
  `<user config dir>/vscode-review-relay/workspaces/<hash of root>/state.json`.
  While the editors used standalone review-relay's server, their reviews
  lived in `<user config dir>/review-relay/workspaces/<hash>/state.json`; a
  root with no review here yet starts from a copy of that one (copied, not
  moved: the standalone viewer may still show it).
- `internal/attach`: the frontends' boundary (below).
- `internal/cli`: the agent commands, unchanged in form from review-relay's
  (`comments list|add|reply|resolve|unresolve|remove|clear`, `navigate`,
  `health`).

## The boundary: `review-relay attach`

A child process speaking JSON lines that carry the HTTP API and the event
stream. Both frontends use it, so neither needs an HTTP client, discovery or
a server lifecycle:

- it **joins** the review already running for the folder (another editor,
  `review-relay serve`), or **runs** one in its own process until its stdin
  closes — so a review is never left running by an editor that quit;
- when the review it uses goes away (the editor that ran it quit), it
  reaches the next one or starts it, and says so (`attached`, then a
  `state` event); every frontend keeps working without code for it;
- `--no-start` only joins: Neovim uses it at startup, so opening Neovim in a
  repository where another editor has the review open shows its threads
  without starting reviews everywhere else.

Stdio rather than HTTP to the frontends because a child's pipe is private to
its parent and ends with it; JSON lines because Lua (`vim.json`) and Node
read them with nothing added. What `attach` carries:

| Request | |
| --- | --- |
| `GET /v1/session` | `{ root }` (also in `attached`) |
| `GET /v1/comments` | `{ overall, comments }`; `?path=`, `?resolved=` |
| `POST /v1/comments`, `POST /v1/comments/:id/replies` | add; reply (moves and reopens the thread) |
| `PATCH /v1/comments/:id` | edit a body |
| `PUT /v1/comments/:id/resolved` | resolve / reopen |
| `PUT /v1/comments/:id/location` | an editor moved the thread's lines: adds nothing, reopens nothing |
| `DELETE /v1/comments/:id`, `DELETE /v1/comments` | delete a comment (a root takes its replies); all |
| `PUT /v1/overall`, `DELETE /v1/review` | the overall comment; clear everything |
| `POST /v1/import` | comments with their ids (the extension's old workspace state, once); known ids are skipped |
| `POST /v1/navigate` | an agent shows a comment or a location: a `navigate` event to every editor attached |
| `GET /v1/instructions` | the agent instructions, with this executable's path |
| `GET /v1/events` | server-sent events: `state` (read again), `navigate` |

The cost: one review per workspace root — a multi-root VS Code window
attaches each file folder separately and keeps the overall comment on the
first; comments live on root-relative paths, so files outside the folders
(untitled documents, other schemes) take none.

## The frontends

Each turns the review into its editor's own terms and back, and decides
nothing else.

- **VS Code** (`src/`): `relay.ts` is the attach client, `store.ts` mirrors
  the folders' reviews (paths ⇄ document URIs, read again on every `state`
  event) behind the interface the comment UI, tree, Review view and cursor
  commands use. `migration.ts` imports a review an earlier version kept in
  the workspace state.
- **Neovim** (`lua/review_relay/`): `client.lua` is the attach client;
  `init.lua` anchors threads to buffer lines with extmarks and sends their
  moves; `cards.lua` is the look; `panel.lua` the panel (the files with
  threads, the threads, the overall comment); `compose.lua` where text is
  written. Each choice and its reason:
  - *Neovim owns input.* A comment is written in a real buffer (markdown) in a
    float under the thread — modes, undo, completion and IME are Neovim's —
    and sent with `<C-s>` or `:w`. Every button a card shows carries its key
    (`r`, `s`), and every action is a command (`:ReviewRelay reply`, …) or a
    key; nothing is mouse-only.
  - *Buffers are the substrate.* A thread is an extmark range on the buffer
    of its file: it follows edits and undo, and a moved thread is told to the
    review, as VS Code's comment ranges are. The panel is a buffer of one line
    per item (searchable, countable) that DevHub draws.
  - *The file is the buffer's own.* A thread shows on any window of its file's
    buffer, whatever else shows it — a plain window, a window in diff mode —
    and a comment goes where the cursor is. A buffer that is no file of the
    work tree (an old revision's scratch buffer) takes none and says so.
  - *DevHub's GUI only through its public API.* In DevHub (`require('devhub')
    .gui`, devhub.nvim) a thread is a `gui.inline` card and the panel a
    `gui.view`. Outside DevHub — or without devhub.nvim — the same thread is
    Neovim's own virt_lines and a sign, and the panel is its text:
    everything works, drawn plainly. DevHub knows nothing of Review Relay,
    and Review Relay nothing of DevHub but that API.
