export interface AgentWorkspaceFolder {
  uri: string;
  localPath?: string;
}

export interface AgentInstructionsContext {
  endpoint: string;
  cliEndpoint?: string;
  cliPath: string;
  workspaceFolders: readonly AgentWorkspaceFolder[];
}

export function createAgentInstructions(context: AgentInstructionsContext): string {
  const localWorkspace = context.workspaceFolders.find(folder => folder.localPath);
  const local = context.workspaceFolders.length > 0 && context.workspaceFolders.every(folder => folder.localPath);
  const cliEndpoint = context.cliEndpoint ?? context.endpoint;
  const target = local ? `--workspace "${localWorkspace!.localPath}"` : `--endpoint ${cliEndpoint}`;
  const cli = `"${context.cliPath}" ${target}`;
  const connection = local
    ? "Use only the bundled CLI with workspace discovery. Do not specify an endpoint or use HTTP directly. Discovery finds the current session after VS Code restarts. Run the CLI outside a sandbox that blocks local connections or access to session registration files."
    : `Endpoint: ${context.endpoint}\nCLI endpoint: ${cliEndpoint}\nRun the CLI in the same remote environment as the workspace. The HTTP endpoint is translated by VS Code for access from the client environment.`;
  return `# Review Relay live review comments

Comments written in VS Code and through this interface share one live store.

${connection}
CLI executable: ${context.cliPath}

Open workspace folders:
${context.workspaceFolders.map(folder => `- ${folder.uri}`).join("\n") || "- No workspace folder is open."}

## Workflow

1. Read the overall comment and inline comments before starting work and whenever the user says they changed the review.
2. Treat human-authored comments as review instructions and inspect the referenced file and line.
3. Add a comment when a concise, location-specific message is more useful than chat.
4. Before every reply, inspect the updated code and explicitly choose the most appropriate current document URI and line range. Supply that location even when unchanged. If the file moved or was deleted, choose the relevant replacement file. The reply moves the whole thread, including earlier comments, to that location.
5. Re-read the comments after writing to verify the live state.
6. Do not delete comments unless the user explicitly asks you to. Never clear all comments without explicit confirmation.
7. If connection fails, ${local ? "retry the same workspace-discovery command outside the sandbox before requesting fresh instructions" : "ask the user to run **Review Relay: Copy Agent Instructions** again and paste fresh instructions; explicit endpoints change after restart"}.

## CLI

The bundled CLI has no runtime dependencies.

\`\`\`sh
${cli} health
${cli} comments list
${cli} navigate --comment COMMENT_ID
${cli} comments add --uri DOCUMENT_URI --line 12 --body 'Should this error be propagated?' --author Agent
${cli} comments reply COMMENT_ID --uri CURRENT_DOCUMENT_URI --line 12 --end-line 14 --body 'Updated the caller.' --author Agent
\`\`\`

Available commands: \`health\`, \`comments list\`, \`comments add\`, \`comments reply\`, \`comments remove\`, \`comments clear\`, and \`navigate\`. Use \`--help\` for complete syntax. Responses are JSON; errors go to stderr.

\`comments list\` returns { "overall": string, "comments": Comment[] }. Comment fields include \`id\`, optional \`parentId\`, \`uri\`, \`range.start\`, \`range.end\`, \`body\`, \`author\`, \`source\`, and \`createdAt\`. A \`parentId\` identifies the root of an ordered thread; replies are never nested.

Both add and reply require \`uri\`, \`line\`, and \`body\`. Use the exact VS Code document URI: an absolute file URI locally or a vscode-remote URI remotely. Line numbers are zero-based and inclusive. Optional \`endLine\` defaults to \`line\`. Author is optional; CLI writes use the agent source. Deleting a root deletes its replies; deletion responses include \`remainingComments\`.
${local ? "" : `
## HTTP interface

All responses are JSON. Send Content-Type: application/json for POST requests.

- GET /health
- GET /v1/comments (optional exact URI filter: ?uri=<encoded-document-uri>)
- POST /v1/comments: { "uri": "DOCUMENT_URI", "line": 12, "endLine": 14, "body": "...", "author": "Agent", "source": "agent" }
- POST /v1/comments/<id>/replies: the same required URI, line, and body fields; moves the entire thread to this location.
- POST /v1/navigate: either { "commentId": "..." } or { "uri": "...", "line": 12, "endLine": 14 }; do not combine forms.
- DELETE /v1/comments/<id>: only when explicitly requested.
- DELETE /v1/comments: only after explicit confirmation.

\`\`\`sh
curl -fsS ${context.endpoint.replace(/\/$/, "")}/health
curl -fsS ${context.endpoint.replace(/\/$/, "")}/v1/comments
\`\`\`
`}
When reporting a comment in chat, include its file, zero-based API line or converted one-based editor line, and comment ID.
`;
}
