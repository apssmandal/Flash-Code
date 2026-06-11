/**
 * Loads the webview HTML. We serve the original self-contained Flash Code UI
 * files (chat/sidebar/dashboard) verbatim — they use inline scripts + handlers,
 * so no nonce/CSP is injected (matching how the UI was authored). Content is
 * driven entirely by the host message protocol.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';

const FILE: Record<string, string> = { chat: 'chat.html', sidebar: 'sidebar.html', dashboard: 'dashboard.html' };

export function buildWebviewHtml(_webview: vscode.Webview, extensionUri: vscode.Uri, entry: 'chat' | 'sidebar' | 'dashboard'): string {
  try {
    const uri = vscode.Uri.joinPath(extensionUri, 'media', FILE[entry]);
    return fs.readFileSync(uri.fsPath, 'utf-8');
  } catch (e: any) {
    return `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:24px;color:#c9d1d9;background:#0d1117">
<h2>⚡ Flash Code</h2><p>Failed to load UI (${entry}): ${e?.message}</p></body></html>`;
  }
}
