import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface SessionDescriptor {
  version: 1;
  id: string;
  endpoint: string;
  workspaceFolders: string[];
  createdAt: string;
}

export class SessionRegistration {
  private readonly id = randomUUID();
  private readonly directory = join(tmpdir(), "vscode-review-relay", "sessions");
  private readonly file = join(this.directory, `${this.id}.json`);

  constructor(private readonly endpoint: string) {}

  async update(workspaceFolders: readonly string[]): Promise<void> {
    const descriptor: SessionDescriptor = {
      version: 1,
      id: this.id,
      endpoint: this.endpoint,
      workspaceFolders: [...workspaceFolders],
      createdAt: new Date().toISOString()
    };
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporaryFile = `${this.file}.tmp`;
    await writeFile(temporaryFile, `${JSON.stringify(descriptor)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryFile, this.file);
  }

  async dispose(): Promise<void> {
    await rm(this.file, { force: true });
  }
}
