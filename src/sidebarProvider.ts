import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SessionProvider } from './sessionProvider';
import { ChatPanel } from './chatPanel';
import { getKeyStatuses } from './backends/gemini';

/** Rich left-panel webview: New Session, search, session list, settings gear. */
export class SidebarProvider implements vscode.WebviewViewProvider {
    public static readonly viewId = 'flashCode.sessions';
    private _view?: vscode.WebviewView;

    constructor(private ctx: vscode.ExtensionContext, private sp: SessionProvider) {
        // Re-render whenever sessions change or the active workspace changes.
        sp.onDidChange(() => this.pushSessions());
        vscode.workspace.onDidChangeWorkspaceFolders(() => this.pushSessions());
    }

    resolveWebviewView(view: vscode.WebviewView) {
        this._view = view;
        view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'media')] };
        view.webview.html = fs.readFileSync(path.join(this.ctx.extensionUri.fsPath, 'media', 'sidebar.html'), 'utf-8');

        view.webview.onDidReceiveMessage(async (m) => {
            const cfg = vscode.workspace.getConfiguration('flashCode');
            switch (m.command) {
                case 'ready':
                    this.pushSettings();
                    this.pushSessions();
                    break;
                case 'openDashboard':
                    vscode.commands.executeCommand('flashCode.openDashboard');
                    break;
                case 'newSession':
                    ChatPanel.createOrShow(this.ctx, this.sp); ChatPanel.cur?.newChat(); break;
                case 'openSession':
                    ChatPanel.createOrShow(this.ctx, this.sp); ChatPanel.cur?.loadSession(m.id); break;
                case 'renameSession': {
                    const name = await vscode.window.showInputBox({ prompt: 'New name', value: m.title || '' });
                    if (name !== undefined) this.sp.renameSession(m.id, name);
                    break;
                }
                case 'deleteSession': {
                    const ok = await vscode.window.showWarningMessage('Delete this chat?', { modal: true }, 'Delete');
                    if (ok === 'Delete') {
                        this.sp.deleteSession(m.id);
                        if (ChatPanel.cur && ChatPanel.cur.getSessionId() === m.id) {
                            ChatPanel.cur.newChat();
                        }
                    }
                    break;
                }
                case 'getSettings':
                    this.pushSettings(); break;
                case 'saveSettings': {
                    const s = m.settings || {};
                    if (s.model === 'ollama') {
                        await cfg.update('defaultBackend', 'ollama', true);
                    } else {
                        await cfg.update('defaultBackend', 'gemini', true);
                        if (s.model) await cfg.update('gemini.model', s.model, true);
                    }
                    if (s.ollamaUrl) await cfg.update('ollama.url', s.ollamaUrl, true);
                    if (s.ollamaModel) await cfg.update('ollama.model', s.ollamaModel, true);
                    if (s.ollamaTemp !== undefined) await cfg.update('ollama.temperature', parseFloat(s.ollamaTemp), true);
                    if (s.ollamaNumCtx !== undefined) await cfg.update('ollama.numCtx', parseInt(s.ollamaNumCtx, 10), true);
                    if (Array.isArray(s.apiKeys)) await cfg.update('gemini.apiKeys', s.apiKeys.filter(Boolean), true);
                    if (s.defaultMode) await cfg.update('mode', s.defaultMode, true);
                    if (s.defaultEffort) await cfg.update('effort', s.defaultEffort, true);
                    ChatPanel.cur?.post({ command: 'restoreSettings', mode: s.defaultMode, effort: s.defaultEffort });
                    ChatPanel.cur?.post({ command: 'setBadge', text: s.model === 'ollama' ? 'ollama' : s.model });
                    vscode.window.showInformationMessage('Flash Code settings saved.');
                    this.pushSettings();
                    break;
                }
            }
        });
        this.pushSessions();
    }

    pushSessions() {
        this._view?.webview.postMessage({ command: 'sessionList', sessions: this.sp.list() });
    }

    pushSettings() {
        const cfg = vscode.workspace.getConfiguration('flashCode');
        const backend = cfg.get<string>('defaultBackend') || 'gemini';
        this._view?.webview.postMessage({
            command: 'settingsData',
            settings: {
                model: backend === 'ollama' ? 'ollama' : (cfg.get<string>('gemini.model') || 'gemini-2.5-flash'),
                apiKeys: cfg.get<string[]>('gemini.apiKeys') || [],
                ollamaUrl: cfg.get<string>('ollama.url') || 'http://localhost:11434',
                ollamaModel: cfg.get<string>('ollama.model') || 'qwen3-coder',
                ollamaTemp: cfg.get<number>('ollama.temperature') ?? 0.2,
                ollamaNumCtx: cfg.get<number>('ollama.numCtx') ?? 4096,
                defaultMode: cfg.get<string>('mode') || 'ask',
                defaultEffort: cfg.get<string>('effort') || 'medium',
            },
            keyStatuses: getKeyStatuses(),
        });
    }

    /** Called by gemini key-status callbacks to live-update the settings UI. */
    pushKeyStatus(s: any) { this._view?.webview.postMessage({ command: 'keyStatusUpdate', status: s }); }

    /** Reveal and open the settings panel (from the chat menu). */
    openSettings() { if (this._view) { this._view.show?.(true); this._view.webview.postMessage({ command: 'openSettings' }); } }
}
