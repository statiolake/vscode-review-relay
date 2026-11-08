// A real review for tests: review-relay (bin/, built by `npm run build:cli`)
// attached to a fresh folder, with its sessions and stored reviews in a
// temporary directory of their own.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { RelayConnection } from "../src/relay";
import { CommentStore, ReviewBackend } from "../src/store";

const platform = process.platform === "win32" ? "windows" : process.platform;
const arch = process.arch === "x64" ? "amd64" : process.arch;
export const cliPath = join(process.cwd(), "bin", `${platform}-${arch}`, platform === "windows" ? "review-relay.exe" : "review-relay");

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "review-relay-test-")));
mkdirSync(join(sandbox, "tmp"));
// Sessions under $TMPDIR, reviews under the config directory: this run's own.
process.env.TMPDIR = join(sandbox, "tmp");
process.env.XDG_CONFIG_HOME = join(sandbox, "config");
process.env.HOME = sandbox;
process.on("exit", () => rmSync(sandbox, { recursive: true, force: true }));

export interface TestReview {
  dir: string;
  folderUri: string;
  relay: RelayConnection;
  backend: ReviewBackend;
  store: CommentStore;
  /** A document URI in the folder. */
  uri(path: string): string;
  close(): void;
}

export function folder(): string {
  return mkdtempSync(join(sandbox, "ws-"));
}

export async function review(dir = folder()): Promise<TestReview> {
  const relay = new RelayConnection(cliPath, dir);
  await relay.attached();
  const folderUri = pathToFileURL(dir).toString();
  const backend: ReviewBackend = {
    folderUri,
    request: (method, path, body) => relay.request(method, path, body),
    onEvent: listener => relay.onEvent(listener)
  };
  const store = new CommentStore();
  const registration = await store.addFolder(backend);
  return {
    dir, folderUri, relay, backend, store,
    uri: path => `${folderUri}/${path}`,
    close: () => { registration.dispose(); relay.dispose(); }
  };
}
