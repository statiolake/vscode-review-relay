package server

import "fmt"

// AgentInstructions is the text an editor copies for pasting into an agent
// chat (GET /v1/instructions).
func AgentInstructions(endpoint, cliPath, root string) string {
	cli := fmt.Sprintf("%q --workspace %q", cliPath, root)
	return fmt.Sprintf(`# Review Relay live review comments

Comments written in the editor (VS Code or Neovim, through Review Relay) and through this interface share one live review.

Use the CLI below; it finds the running review from the workspace path, so it keeps working after the editor restarts. Run it outside a sandbox that blocks local connections or access to the temporary directory.
CLI executable: %[2]s
Workspace root: %[3]s

## Workflow

1. Read the overall comment and inline comments before starting work and whenever the user says they changed the review.
2. Treat human-authored comments as review instructions and inspect the referenced file and line. Skip resolved threads (root comment has `+"`\"resolved\": true`"+`): the user is done with them, so they are not pending work. `+"`comments list --unresolved`"+` leaves them out.
3. Add a comment when a concise, location-specific message is more useful than chat.
4. Before every reply, inspect the updated code and explicitly choose the most appropriate current path and line range. Supply that location even when unchanged. If the file moved or was deleted, choose the relevant replacement file. The reply moves the whole thread, including earlier comments, to that location.
5. Re-read the comments after writing to verify the live state.
6. Do not delete comments unless the user explicitly asks you to. Never clear all comments without explicit confirmation. Resolve or reopen threads only when the user asks; replying to a resolved thread reopens it, so do not reply to one unless asked.
7. If the connection fails, retry the same command outside the sandbox before asking the user to check that the workspace is open in their editor.

## CLI

`+"```sh"+`
%[1]s health
%[1]s comments list --unresolved
%[1]s navigate --comment COMMENT_ID
%[1]s comments add --path src/main.go --line 12 --body 'Should this error be propagated?' --author Agent
%[1]s comments reply COMMENT_ID --path src/main.go --line 12 --end-line 14 --body 'Updated the caller.' --author Agent
`+"```"+`

Available commands: `+"`health`, `comments list`, `comments add`, `comments reply`, `comments resolve`, `comments unresolve`, `comments remove`, `comments clear`, and `navigate`"+`. Use `+"`--help`"+` for complete syntax. Responses are JSON; errors go to stderr.

`+"`comments list`"+` returns { "overall": string, "comments": Comment[] }. Comment fields are `+"`id`, optional `parentId`, `path`, `line`, `endLine`, `body`, `author`, `source`, `createdAt`, and `resolved`"+` (true on the root of a resolved thread, omitted otherwise). A `+"`parentId`"+` identifies the root of an ordered thread; replies are never nested.

Both add and reply require `+"`path`, `line`, and `body`"+`. Paths are slash-separated and relative to the workspace root. Line numbers are zero-based and inclusive (editor line 1 is line 0). Optional `+"`endLine`"+` defaults to `+"`line`"+`. Author is optional; CLI writes use the agent source. Deleting a root deletes its replies; deletion responses include `+"`remainingComments`"+`.

`+"`navigate`"+` shows a comment or a location in the editors that have the review open.

## HTTP interface

The review currently listens on %[4]s (the port changes when it restarts). All responses are JSON. Send Content-Type: application/json for POST and PUT requests.

- GET /health
- GET /v1/comments (optional exact path filter: ?path=<encoded-path>; ?resolved=false keeps only open threads)
- POST /v1/comments: { "path": "src/main.go", "line": 12, "endLine": 14, "body": "...", "author": "Agent", "source": "agent" }
- POST /v1/comments/<id>/replies: the same required path, line, and body fields; moves the entire thread to this location.
- PUT /v1/comments/<id>/resolved: { "resolved": true } or false; any comment of the thread may be given. Only when the user asks.
- POST /v1/navigate: either { "commentId": "..." } or { "path": "...", "line": 12, "endLine": 14 }; do not combine forms.
- DELETE /v1/comments/<id>: only when explicitly requested.
- DELETE /v1/comments: only after explicit confirmation.

When reporting a comment in chat, include its path, zero-based API line or converted one-based editor line, and comment ID.
`, cli, cliPath, root, endpoint)
}
