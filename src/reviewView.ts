import * as vscode from "vscode";
import { CommentStore } from "./store";
import { renderWebviewDocument } from "./webviewDocument";

type IncomingMessage =
  | { type: "ready" }
  | { type: "overallChanged"; value: string }
  | { type: "copyMarkdown" }
  | { type: "copyAgentInstructions" };

export class ReviewViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = "reviewRelay.review";
  private view?: vscode.WebviewView;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly store: CommentStore) {
    this.subscription = store.onDidChange(change => {
      if (change.overall) this.postState();
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
      case "overallChanged": await this.store.setOverall(message.value); break;
      case "copyMarkdown": await vscode.commands.executeCommand("reviewRelay.copyMarkdown"); break;
      case "copyAgentInstructions": await vscode.commands.executeCommand("reviewRelay.copyAgentInstructions"); break;
    }
  }

  private postState(): void {
    void this.view?.webview.postMessage({
      type: "state",
      overall: this.store.getOverall()
    });
  }

  private html(webview: vscode.Webview): string {
    return renderWebviewDocument(webview, {
      styles: `
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; padding: 12px; color: var(--vscode-foreground); font: var(--vscode-font-size)/1.4 var(--vscode-font-family); }
  main { display: grid; grid-template-rows: minmax(0, 1fr) auto; gap: 20px; height: 100%; min-height: 0; }
  section { display: grid; gap: 8px; min-height: 0; }
  section:first-child { grid-template-rows: auto minmax(0, 1fr) auto; }
  section + section { padding-top: 12px; border-top: 1px solid var(--vscode-widget-border, transparent); }
  h2 { margin: 0; font-size: 13px; font-weight: 600; }
  textarea { width: 100%; min-height: 0; resize: none; padding: 8px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); font: var(--vscode-editor-font-size) var(--vscode-editor-font-family); }
  textarea:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  button { width: 100%; border: 0; border-radius: 2px; padding: 7px 10px; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); font: inherit; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  .secondary { color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); background: var(--vscode-button-secondaryBackground, var(--vscode-editorWidget-background)); }
  .secondary:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); }
`,
      body: `<main>
  <section>
    <h2>Overall comment</h2>
    <textarea id="overall" placeholder="Summary, overall guidance, or context for the coding agent…"></textarea>
    <button id="copyMarkdown">Copy as Markdown</button>
  </section>
  <section>
    <h2>Options</h2>
    <button class="secondary" id="copyAgent">Copy Agent Instructions</button>
  </section>
</main>`,
      script: `
  const vscode = acquireVsCodeApi();
  const overall = document.getElementById('overall');
  let timer;
  let lastSent = '';
  let composing = false;
  const sendOverall = () => {
    clearTimeout(timer);
    if (!composing && overall.value !== lastSent) {
      lastSent = overall.value;
      vscode.postMessage({ type: 'overallChanged', value: overall.value });
    }
  };
  const scheduleOverall = () => {
    clearTimeout(timer);
    if (!composing) timer = setTimeout(sendOverall, 250);
  };
  overall.addEventListener('input', scheduleOverall);
  overall.addEventListener('compositionstart', () => {
    composing = true;
    clearTimeout(timer);
  });
  overall.addEventListener('compositionend', () => {
    composing = false;
    scheduleOverall();
  });
  overall.addEventListener('blur', sendOverall);
  document.getElementById('copyMarkdown').addEventListener('click', () => vscode.postMessage({ type: 'copyMarkdown' }));
  document.getElementById('copyAgent').addEventListener('click', () => vscode.postMessage({ type: 'copyAgentInstructions' }));
  window.addEventListener('message', event => {
    const state = event.data;
    if (state.type !== 'state' || document.activeElement === overall) return;
    overall.value = state.overall;
    lastSent = state.overall;
  });
  vscode.postMessage({ type: 'ready' });
`
    });
  }

  dispose(): void {
    this.subscription.dispose();
  }
}
