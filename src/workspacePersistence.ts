import { ReviewRelayState } from "./model";
import { CommentPersistence } from "./store";

export const STORAGE_KEY = "reviewRelay.state.v1";

export interface WorkspaceMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

export function createWorkspacePersistence(storage: WorkspaceMemento): CommentPersistence {
  return {
    load: () => storage.get<unknown>(STORAGE_KEY) ?? emptyState(),
    save: state => storage.update(STORAGE_KEY, state)
  };
}

export function resetWorkspaceData(storage: WorkspaceMemento): PromiseLike<void> {
  // Emergency recovery must discard the opaque value without reading or interpreting it.
  return storage.update(STORAGE_KEY, undefined);
}

function emptyState(): ReviewRelayState {
  return { comments: [], overall: "", showAgentLastOnly: false };
}
