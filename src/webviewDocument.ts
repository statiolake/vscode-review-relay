import * as vscode from "vscode";

interface WebviewDocument {
  styles: string;
  body: string;
  script: string;
}

export function renderWebviewDocument(webview: vscode.Webview, document: WebviewDocument): string {
  const nonce = createNonce();
  const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'`;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<style>${document.styles}</style></head><body>${document.body}<script nonce="${nonce}">${document.script}</script></body></html>`;
}

function createNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}
