import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { CommentStore } from "./store";
import { validateCreateComment, validateNavigate } from "./model";
import { NavigationService } from "./navigation";

const MAX_BODY_BYTES = 64 * 1024;

export class CommentServer {
  private server?: Server;
  constructor(
    private readonly store: CommentStore,
    private readonly navigation: NavigationService
  ) {}

  async start(port: number): Promise<number> {
    this.server = createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, "127.0.0.1", resolve);
    });
    return (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => this.server!.close(error => error ? reject(error) : resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.headers.origin) return this.json(response, 403, { error: "Browser-origin requests are not allowed." });
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/health") return this.json(response, 200, { ok: true, version: 1 });
      if (request.method === "GET" && url.pathname === "/v1/comments") {
        const uri = url.searchParams.get("uri");
        const comments = uri ? this.store.list().filter(comment => comment.uri === uri) : this.store.list();
        return this.json(response, 200, { comments });
      }
      if (request.method === "POST" && url.pathname === "/v1/comments") {
        if (!request.headers["content-type"]?.startsWith("application/json")) return this.json(response, 415, { error: "Content-Type must be application/json." });
        const comment = await this.store.add(validateCreateComment(await this.readJson(request)));
        return this.json(response, 201, { comment });
      }
      if (request.method === "POST" && url.pathname === "/v1/navigate") {
        if (!request.headers["content-type"]?.startsWith("application/json")) return this.json(response, 415, { error: "Content-Type must be application/json." });
        const input = validateNavigate(await this.readJson(request));
        let target;
        let commentId: string | undefined;
        if ("commentId" in input) {
          const comment = this.store.list().find(candidate => candidate.id === input.commentId);
          if (!comment) return this.json(response, 404, { error: "Comment not found." });
          commentId = comment.id;
          target = { uri: comment.uri, line: comment.range.start.line, endLine: comment.range.end.line, commentId };
        } else {
          target = { uri: input.uri, line: input.line, endLine: input.endLine ?? input.line };
        }
        await this.navigation.navigate(target);
        return this.json(response, 200, { navigated: target });
      }
      const match = /^\/v1\/comments\/([^/]+)$/.exec(url.pathname);
      if (request.method === "DELETE" && match) {
        const removed = await this.store.remove(decodeURIComponent(match[1]));
        return this.json(response, removed ? 200 : 404, removed ? { removed: true } : { error: "Comment not found." });
      }
      if (request.method === "DELETE" && url.pathname === "/v1/comments") {
        return this.json(response, 200, { removed: await this.store.clear() });
      }
      this.json(response, 404, { error: "Not found." });
    } catch (error) {
      this.json(response, 400, { error: error instanceof Error ? error.message : "Invalid request." });
    }
  }

  private async readJson(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_BODY_BYTES) throw new Error("Request body is too large.");
      chunks.push(buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }

  private json(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(`${JSON.stringify(value)}\n`);
  }
}
