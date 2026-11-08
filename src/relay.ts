import { ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";

/**
 * One workspace folder's review, through `review-relay attach` (the core,
 * cmd/review-relay): a child process that speaks JSON lines and carries the
 * review's HTTP API and its event stream. It uses the review already running
 * for the folder (another editor, `review-relay serve`) or runs one until
 * this connection closes, and reaches the next one by itself when the one it
 * uses goes away. Nothing about a review is decided here.
 */
export interface Attached {
  endpoint: string;
  root: string;
  owner: boolean;
  session: { root?: string };
}

export interface RelayEvent {
  name: string;
  data: unknown;
}

export class RelayError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export class RelayConnection {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private attachedValue?: Attached;
  private readonly attachedWaiters: Array<{ resolve(value: Attached): void; reject(error: Error): void }> = [];
  private readonly listeners = new Set<(event: RelayEvent) => void>();
  private readonly attachListeners = new Set<(attached: Attached) => void>();
  private failure?: Error;
  private stderr = "";

  constructor(executable: string, workspace: string) {
    this.child = spawn(executable, ["attach", "--workspace", workspace], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child.on("error", error => this.fail(new Error(`Could not run ${executable}: ${error.message}`)));
    this.child.on("exit", code => this.fail(new Error(
      `review-relay attach exited (${code ?? "signal"})${this.stderr.trim() ? `: ${this.stderr.trim()}` : ""}`
    )));
    this.child.stderr!.setEncoding("utf8");
    this.child.stderr!.on("data", chunk => { this.stderr = (this.stderr + chunk).slice(-4096); });
    this.child.stdin!.on("error", () => undefined);
    createInterface({ input: this.child.stdout! }).on("line", line => this.receive(line));
  }

  /** The first attach; later ones (the review was reached again) go to onDidAttach. */
  attached(): Promise<Attached> {
    if (this.attachedValue) return Promise.resolve(this.attachedValue);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => this.attachedWaiters.push({ resolve, reject }));
  }

  get current(): Attached | undefined { return this.attachedValue; }

  onEvent(listener: (event: RelayEvent) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  onDidAttach(listener: (attached: Attached) => void): { dispose(): void } {
    this.attachListeners.add(listener);
    return { dispose: () => this.attachListeners.delete(listener) };
  }

  /** An API request; a non-2xx answer rejects with the server's message. */
  async request<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    if (this.failure) throw this.failure;
    const id = this.nextId++;
    const line = JSON.stringify(body === undefined ? { id, method, path } : { id, method, path, body });
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.child.stdin!.write(`${line}\n`);
    });
  }

  dispose(): void {
    this.child.stdin!.end();
    // attach stops a review it runs once its stdin closes; this is in case it hangs.
    setTimeout(() => this.child.kill(), 3000).unref();
  }

  private receive(line: string): void {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    switch (message?.type) {
      case "attached": {
        const attached: Attached = {
          endpoint: message.endpoint, root: message.root, owner: message.owner === true, session: message.session ?? {}
        };
        const first = !this.attachedValue;
        this.attachedValue = attached;
        if (first) this.attachedWaiters.splice(0).forEach(waiter => waiter.resolve(attached));
        else this.attachListeners.forEach(listener => listener(attached));
        break;
      }
      case "response": {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.status >= 200 && message.status < 300) pending.resolve(message.body);
        else pending.reject(new RelayError(message.body?.error ?? `review-relay answered ${message.status}`, message.status));
        break;
      }
      case "event":
        this.listeners.forEach(listener => listener({ name: message.name, data: message.data }));
        break;
      case "error":
        this.fail(new Error(message.message ?? "review-relay attach failed"));
        break;
    }
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.attachedWaiters.splice(0).forEach(waiter => waiter.reject(error));
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
