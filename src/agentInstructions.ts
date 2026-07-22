export interface AgentInstructionsContext {
  endpoint: string;
  workspaceFolders: readonly string[];
}

export function createAgentInstructions(context: AgentInstructionsContext): string {
  const workspaces = context.workspaceFolders.length > 0
    ? context.workspaceFolders.map(uri => `- ${uri}`).join("\n")
    : "- No workspace folder is currently open. Use an absolute file URI from the editor.";

  return `# Commentator live review comments

This VS Code session exposes live review comments to local tools. Use this interface while working on the user's code. Comments written by the user in VS Code and comments written through this API share one live store.

Endpoint: ${context.endpoint}

Open workspace folders:
${workspaces}

## Workflow

1. Read the comments before starting work and whenever the user says they added or changed comments.
2. Treat human-authored comments as review instructions and inspect the referenced file and line.
3. Use the API to add a comment when a concise, location-specific message is more useful than chat.
4. Re-read the comments after writing so you can verify the live state.
5. Do not delete comments unless the user explicitly asks you to. Never clear all comments without explicit confirmation.

## HTTP interface

All responses are JSON. The server only listens on 127.0.0.1.

- GET /health
  Returns server health and API version.
- GET /v1/comments
  Returns { "comments": Comment[] }.
- GET /v1/comments?uri=<encoded-file-uri>
  Filters comments by exact VS Code document URI.
- POST /v1/comments
  Creates a comment. Send Content-Type: application/json.
- DELETE /v1/comments/<id>
  Deletes one comment. Only use when explicitly requested.
- DELETE /v1/comments
  Deletes every comment. Only use when explicitly requested.

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

\`uri\` must be a VS Code document URI, normally an absolute \`file:///...\` URI. \`line\` and optional \`endLine\` are zero-based and inclusive. \`body\` is required. \`author\`, \`source\`, and \`endLine\` are optional; \`source\` is either \`human\` or \`agent\`.

Comment response fields include \`id\`, \`uri\`, \`range.start\`, \`range.end\`, \`body\`, \`author\`, \`source\`, and \`createdAt\`. Range lines and characters are zero-based.

## Examples

\`\`\`sh
curl -fsS ${context.endpoint}/health
curl -fsS ${context.endpoint}/v1/comments
curl -fsS -X POST ${context.endpoint}/v1/comments \\
  -H 'content-type: application/json' \\
  -d '{"uri":"file:///absolute/path/src/app.ts","line":12,"body":"Should this error be propagated?","author":"Agent","source":"agent"}'
\`\`\`

When reporting a comment in chat, include its file, zero-based API line or converted one-based editor line, and comment ID so it can be identified unambiguously.
`;
}
