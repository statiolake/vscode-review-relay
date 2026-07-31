export interface AgentWorkspaceFolder {
  uri: string;
  localPath?: string;
}

export interface AgentInstructionsContext {
  endpoint: string;
  cliPath: string;
  workspaceFolders: readonly AgentWorkspaceFolder[];
}

export function createAgentInstructions(context: AgentInstructionsContext): string {
  const workspaces = context.workspaceFolders.length > 0
    ? context.workspaceFolders.map(folder => `- ${folder.uri}`).join("\n")
    : "- No workspace folder is currently open. Use an absolute file URI from the editor.";
  const localWorkspace = context.workspaceFolders.find(folder => folder.localPath);
  const cliTarget = localWorkspace
    ? `--workspace "${localWorkspace.localPath}"`
    : `--endpoint ${context.endpoint}`;

  return `# Review Relay live review comments

This VS Code session exposes live review comments to local tools. Use this interface while working on the user's code. Comments written by the user in VS Code and comments written through this API share one live store.

Endpoint: ${context.endpoint}
CLI executable: ${context.cliPath}

Open workspace folders:
${workspaces}

## Workflow

1. Read the overall comment and inline comments before starting work and whenever the user says they changed the review.
2. Treat human-authored comments as review instructions and inspect the referenced file and line.
3. Use the API to add a comment when a concise, location-specific message is more useful than chat.
4. Re-read the comments after writing so you can verify the live state.
5. Do not delete comments unless the user explicitly asks you to. Never clear all comments without explicit confirmation.
6. If the CLI or endpoint cannot connect, ask the user to run **Review Relay: Copy Agent Instructions** again and paste the fresh instructions. The endpoint can change when VS Code restarts.

## CLI

Prefer the bundled CLI. It has no runtime dependencies. Local workspaces discover this VS Code session from the workspace path. Remote workspaces such as Dev Containers use the explicit local \`--endpoint\` because their workspace paths do not exist on the UI host.

\`\`\`sh
"${context.cliPath}" ${cliTarget} health
"${context.cliPath}" ${cliTarget} comments list
"${context.cliPath}" ${cliTarget} navigate --comment COMMENT_ID
"${context.cliPath}" ${cliTarget} comments add --uri DOCUMENT_URI --line 12 --body 'Should this error be propagated?' --author Agent
"${context.cliPath}" ${cliTarget} comments reply COMMENT_ID --line 12 --body 'Yes. I updated the caller as well.' --author Agent
\`\`\`

Available commands are \`health\`, \`comments list\`, \`comments add\`, \`comments reply\`, \`comments remove\`, \`comments clear\`, and \`navigate\`. Use \`--help\` for the complete syntax. The CLI prints the API JSON response to stdout and errors to stderr.

## HTTP interface

All responses are JSON. The server only listens on 127.0.0.1.

- GET /health
  Returns server health and API version.
- GET /v1/comments
  Returns { "overall": string, "comments": Comment[] }.
- GET /v1/comments?uri=<encoded-file-uri>
  Filters comments by exact VS Code document URI.
- POST /v1/comments
  Creates a comment. Send Content-Type: application/json.
- POST /v1/comments/<id>/replies
  Replies to an existing comment. Send { "line": 12, "endLine": 14, "body": "...", "author": "...", "source": "agent" }. \`line\` is required and is the current zero-based start line. \`endLine\` is optional and defaults to \`line\`; the reply moves the whole thread to the supplied range. Read the thread with \`comments list\` first and reuse its current \`range.start.line\` when the location has not changed.
- POST /v1/navigate
  Opens and reveals a location in VS Code. Send either { "commentId": "..." } or { "uri": "...", "line": 12, "endLine": 14 }. Do not combine target forms.
- DELETE /v1/comments/<id>
  Deletes one comment and returns the number of remaining comments. Only use when explicitly requested.
- DELETE /v1/comments
  Deletes every inline comment and returns the number removed. Only use when explicitly requested.

Create request:

\`\`\`json
{
  "uri": "file:///absolute/path/to/file.ts",
  "line": 12,
  "endLine": 14,
  "body": "Explain the issue or suggestion clearly.",
  "author": "Agent name",
  "source": "agent"
}
\`\`\`

\`uri\` must be the exact VS Code document URI, such as an absolute \`file:///...\` URI locally or a \`vscode-remote://...\` URI in a remote workspace. Reuse URIs returned by the API when possible. \`line\` and optional \`endLine\` are zero-based and inclusive. \`body\` is required. \`author\`, \`source\`, and \`endLine\` are optional; \`source\` is either \`human\` or \`agent\`.

Comment response fields include \`id\`, optional \`parentId\`, \`uri\`, \`range.start\`, \`range.end\`, \`body\`, \`author\`, \`source\`, and \`createdAt\`. A \`parentId\` identifies the root of an ordered comment thread; replies are never nested. Range lines and characters are zero-based. Delete responses include \`remainingComments\`; use it to notice when more review work remains. Deleting a root comment also deletes its replies.

## Examples

\`\`\`sh
curl -fsS ${context.endpoint}/health
curl -fsS ${context.endpoint}/v1/comments
curl -fsS -X POST ${context.endpoint}/v1/navigate \\
  -H 'content-type: application/json' \\
  -d '{"commentId":"COMMENT_ID"}'
curl -fsS -X POST ${context.endpoint}/v1/comments \\
  -H 'content-type: application/json' \\
  -d '{"uri":"DOCUMENT_URI","line":12,"body":"Should this error be propagated?","author":"Agent","source":"agent"}'
curl -fsS -X POST ${context.endpoint}/v1/comments/COMMENT_ID/replies \\
  -H 'content-type: application/json' \\
  -d '{"line":12,"body":"Yes. I updated the caller as well.","author":"Agent","source":"agent"}'
\`\`\`

When reporting a comment in chat, include its file, zero-based API line or converted one-based editor line, and comment ID so it can be identified unambiguously.
`;
}
