import * as vscode from "vscode";
import { CommentStore } from "./store";

type IncomingMessage =
  | { type: "ready" }
  | { type: "overallChanged"; value: string }
  | { type: "includeAiChanged"; value: boolean }
  | { type: "clear" }
  | { type: "copyMarkdown" }
  | { type: "copyAgentInstructions" };

export class ReviewViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = "reviewRelay.review";
  private view?: vscode.WebviewView;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly store: CommentStore) {
    this.subscription = store.onDidChange(() => this.postState());
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
      case "includeAiChanged": await this.store.setIncludeAiGenerated(message.value); break;
      case "clear": await vscode.commands.executeCommand("reviewRelay.clearReview"); break;
      case "copyMarkdown": await vscode.commands.executeCommand("reviewRelay.copyMarkdown"); break;
      case "copyAgentInstructions": await vscode.commands.executeCommand("reviewRelay.copyAgentInstructions"); break;
    }
  }

  private postState(): void {
    const comments = this.store.list();
    void this.view?.webview.postMessage({
      type: "state",
      overall: this.store.getOverall(),
      includeAiGenerated: this.store.includesAiGenerated(),
      humanCount: comments.filter(comment => comment.source === "human").length,
      aiCount: comments.filter(comment => comment.source === "agent").length
    });
  }

  private html(webview: vscode.Webview): string {
    const nonce = createNonce();
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'`;
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 12px; color: var(--vscode-foreground); font: var(--vscode-font-size)/1.4 var(--vscode-font-family); }
  main { min-height: calc(100vh - 24px); display: flex; flex-direction: column; gap: 12px; }
  .heading { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  h2 { margin: 0; font-size: 13px; font-weight: 600; }
  .count, .feedback { color: var(--vscode-descriptionForeground); font-size: 11px; }
  textarea { width: 100%; min-height: 160px; flex: 1; resize: vertical; padding: 8px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); font: var(--vscode-editor-font-size) var(--vscode-editor-font-family); }
  textarea:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .option { display: flex; align-items: center; gap: 7px; cursor: pointer; }
  .option input { margin: 0; }
  .actions { display: grid; grid-template-columns: auto 1fr; gap: 8px; }
  button { border: 0; border-radius: 2px; padding: 7px 10px; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); font: inherit; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .agent { margin-top: 2px; padding-top: 12px; border-top: 1px solid var(--vscode-widget-border); display: grid; gap: 7px; }
  .agent button { width: 100%; }
</style></head><body><main>
  <div class="heading"><h2>Overall comment</h2><span id="count" class="count"></span></div>
  <textarea id="overall" placeholder="Summary, overall guidance, or context for the coding agent…"></textarea>
  <label class="option"><input id="includeAi" type="checkbox"> Include AI-generated comments</label>
  <div class="actions"><button id="clear" class="secondary">Clear</button><button id="copyMarkdown">Copy as Markdown</button></div>
  <span id="feedback" class="feedback" aria-live="polite"></span>
  <section class="agent"><h2>Live agent connection</h2><span class="count">Copy the endpoint, CLI path, and interface contract.</span><button id="copyAgent" class="secondary">Copy Agent Instructions</button></section>
</main><script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const overall = document.getElementById('overall');
  const includeAi = document.getElementById('includeAi');
  const count = document.getElementById('count');
  const feedback = document.getElementById('feedback');
  let timer; let lastSent = '';
  function flash(text) { feedback.textContent = text; setTimeout(() => { if (feedback.textContent === text) feedback.textContent = ''; }, 1600); }
  overall.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { if (overall.value !== lastSent) { lastSent = overall.value; vscode.postMessage({ type: 'overallChanged', value: overall.value }); } }, 250); });
  includeAi.addEventListener('change', () => vscode.postMessage({ type: 'includeAiChanged', value: includeAi.checked }));
  document.getElementById('clear').addEventListener('click', () => vscode.postMessage({ type: 'clear' }));
  document.getElementById('copyMarkdown').addEventListener('click', () => { vscode.postMessage({ type: 'copyMarkdown' }); flash('Markdown copied'); });
  document.getElementById('copyAgent').addEventListener('click', () => { vscode.postMessage({ type: 'copyAgentInstructions' }); flash('Agent instructions copied'); });
  window.addEventListener('message', event => { const state = event.data; if (state.type !== 'state') return; if (document.activeElement !== overall) { overall.value = state.overall; lastSent = state.overall; } includeAi.checked = state.includeAiGenerated; count.textContent = state.humanCount + ' human · ' + state.aiCount + ' AI'; });
  vscode.postMessage({ type: 'ready' });
</script></body></html>`;
  }

  dispose(): void { this.subscription.dispose(); }
}

function createNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}
