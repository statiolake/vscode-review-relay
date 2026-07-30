import * as vscode from "vscode";
import { CommentStore } from "./store";
import { renderWebviewDocument } from "./webviewDocument";

type IncomingMessage =
  | { type: "ready" }
  | { type: "showAgentLastOnlyChanged"; value: boolean }
  | { type: "copyAgentInstructions" };

export class CommentsControlsViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = "reviewRelay.commentsControls";
  private view?: vscode.WebviewView;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly store: CommentStore) {
    this.subscription = store.onDidChange(change => {
      if (change.showAgentLastOnly) this.postState();
    });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((message: IncomingMessage) => void this.receive(message));
  }

  private async receive(message: IncomingMessage): Promise<void> {
    switch (message.type) {
      case "ready": this.postState(); break;
      case "showAgentLastOnlyChanged": await this.store.setShowAgentLastOnly(message.value); break;
      case "copyAgentInstructions":
        await vscode.commands.executeCommand("reviewRelay.copyAgentInstructions");
        break;
    }
  }

  private postState(): void {
    void this.view?.webview.postMessage({
      type: "state",
      showAgentLastOnly: this.store.showsAgentLastOnly()
    });
  }

  private html(webview: vscode.Webview): string {
    return renderWebviewDocument(webview, {
      styles: `
  * { box-sizing: border-box; }
  body { margin: 0; padding: 12px; color: var(--vscode-foreground); font: var(--vscode-font-size)/1.4 var(--vscode-font-family); }
  main { display: grid; gap: 12px; }
  label { display: flex; align-items: center; gap: 7px; cursor: pointer; }
  input { margin: 0; }
  button { width: 100%; border: 0; border-radius: 2px; padding: 7px 10px; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); font: inherit; }
  button:hover { background: var(--vscode-button-hoverBackground); }
`,
      body: `<main>
  <label><input id="showAgentLastOnly" type="checkbox"> Show only threads last answered by AI</label>
  <button id="copyAgent">Copy Agent Instructions</button>
</main>`,
      script: `
  const vscode = acquireVsCodeApi();
  const showAgentLastOnly = document.getElementById('showAgentLastOnly');
  showAgentLastOnly.addEventListener('change', () => vscode.postMessage({ type: 'showAgentLastOnlyChanged', value: showAgentLastOnly.checked }));
  document.getElementById('copyAgent').addEventListener('click', () => vscode.postMessage({ type: 'copyAgentInstructions' }));
  window.addEventListener('message', event => {
    const state = event.data;
    if (state.type === 'state') showAgentLastOnly.checked = state.showAgentLastOnly;
  });
  vscode.postMessage({ type: 'ready' });
`
    });
  }

  dispose(): void {
    this.subscription.dispose();
  }
}
