# Architecture: one core, thin frontends

Review Relay is a review shared between a person and coding agents: threads on
lines of a workspace's files, an overall comment, resolve / reopen, and a
live view of what the other side wrote. This repository holds two
**frontends** of it — the VS Code extension (`src/`) and the Neovim plugin
(`lua/`, `plugin/`) — and no review logic. The **core** is
[review-relay](https://github.com/statiolake/review-relay).

```
            agents ── review-relay comments … (CLI) ──┐
                                                      ▼
 VS Code ─ spawn ─▶ review-relay attach ─ HTTP ─▶ review-relay server ◀─ HTTP ─ viewer window / browser
 Neovim  ─ jobstart ▶ review-relay attach ─ HTTP ─▶  (one per workspace:
                                                     store, validation, events)
```

## Why the core is review-relay's server

Until 0.4 the extension carried a review of its own: a TypeScript store and
model (zod), a loopback HTTP server, session files and a Go CLI, side by side
with review-relay, which had the same model, the same API shape and its own
CLI in Go. Two implementations of one review drift, and a third frontend
(Neovim) would have made three. The earlier direction was to reuse
review-relay's logic rather than write it again, so:

- **review-relay's server is the core.** It already owns everything a review
  is: the model and its rules (a reply moves its thread and reopens it; only
  roots resolve), validation, storage outside the workspace, the event
  stream, agent discovery from a directory, the agent CLI and the agent
  instructions. Every client goes through the one API under `/v1/`; the
  viewer page was moved onto it (it had its own `/ui/` routes), so there is
  no API that only one client may use.
- **What frontends needed was added to the core, generically:** moving a
  thread without replying (`PUT /v1/comments/:id/location`: an editor's lines
  moved), importing comments with their ids (`POST /v1/import`: the
  extension's old workspace state, once), reviewed marks announcing their
  changes, and a build without cgo (no window; cross-compiles), which is the
  binary the frontends ship.
- **The boundary is `review-relay attach`**, a child process speaking JSON
  lines that carry the HTTP API and the event stream. Both frontends use it,
  so neither needs an HTTP client, discovery or a server lifecycle:
  - it **joins** the review already running for the folder (a window, an
    agent's `--no-window`, another editor), or **runs** one in its own
    process until its stdin closes — so a review is never left running by
    an editor that quit;
  - when the review it uses goes away (the editor that ran it quit), it
    reaches the next one or starts it, and says so (`attached`, then a
    `state` event); every frontend keeps working without code for it;
  - `--no-start` only joins: Neovim uses it at startup, so opening Neovim in
    a repository where an agent started a review shows its threads without
    starting reviews everywhere else.
  Stdio rather than HTTP to the frontends because a child's pipe is private
  to its parent and ends with it; JSON lines because Lua (`vim.json`) and
  Node read them with nothing added.
- **One binary, one version.** `go.mod` pins review-relay as a tool; `npm run
  build:cli` (the extension) and `build.lua` (lazy.nvim) build exactly that
  version into `bin/<os>-<arch>/`. A frontend talking to a running review of
  another build only meets the same `/v1/` API.

The cost: one review per workspace folder, as review-relay has always had —
a multi-root VS Code window attaches each file folder separately and keeps
the overall comment on the first; comments live on workspace-relative paths,
so files outside the folders (untitled documents, other schemes) take none.

## The frontends

Each turns the review into its editor's own terms and back, and decides
nothing else.

- **VS Code** (`src/`): `relay.ts` is the attach client, `store.ts` mirrors
  the folders' reviews (paths ⇄ document URIs, read again on every `state`
  event) behind the interface the comment UI, tree, Review view and cursor
  commands already used, so they are unchanged.
- **Neovim** (`lua/review_relay/`): `client.lua` is the attach client;
  `init.lua` anchors threads to buffer lines with extmarks and sends their
  moves; `cards.lua` is the look; `panel.lua` the panel; `compose.lua` where
  text is written. Each choice and its reason:
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
    work tree (an old revision's scratch buffer) takes none and says so. No
    convention with other plugins is needed: a diff tool that shows the work
    tree in the file's own buffer gets threads for free.
  - *DevHub's GUI only through its public API.* In DevHub (`require('devhub')
    .gui`, devhub.nvim) a thread is a `gui.inline` card and the panel a
    `gui.view`; the card keeps the look of the earlier devhub.nvim adapter
    (status badge, avatars, markdown, Reply / Resolve with their keys)
    without a coloured stripe. Outside DevHub — or without devhub.nvim — the
    same thread is Neovim's own virt_lines and a sign, and the panel is its
    text: everything works, drawn plainly. DevHub knows nothing of Review
    Relay, and Review Relay nothing of DevHub but that API.
