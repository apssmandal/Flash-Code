/**
 * Sidebar webview (original sidebar.html): session list + sliding settings panel.
 * Speaks the original protocol (sessionList / settingsData / keyStatusUpdate) and
 * maps the multi-provider settings onto the registry + Secret Storage.
 */

import * as vscode from 'vscode';
import { ProviderRegistry } from '../providers/registry';
import { SecretStore } from '../secrets';
import { buildWebviewHtml } from './webviewHtml';
import { SessionManager } from '../session/sessionManager';
import { sessionEvents } from '../session/sessionEvents';
import { DashboardController } from './dashboardController';
import { UsageTracker } from './usageTracker';

export class SidebarProvider implements vscode.WebviewViewProvider {
  static viewId = 'flashCode.sessions';
  private view?: vscode.WebviewView;
  private sessions: SessionManager;

  constructor(private ctx: vscode.ExtensionContext, private providers: ProviderRegistry, private secrets: SecretStore) {
    this.sessions = new SessionManager(ctx);
    ctx.subscriptions.push(sessionEvents.event(() => this.pushSessions()));
    // Keep an open Usage section fresh as calls are recorded.
    ctx.subscriptions.push(UsageTracker.changed.event(() => this.pushUsage()));
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'media')] };
    view.webview.html = buildWebviewHtml(view.webview, this.ctx.extensionUri, 'sidebar');
    view.webview.onDidReceiveMessage((m: any) => this.onMessage(m));
  }

  /** Open the settings panel programmatically (from the chat "gear"/model). */
  openSettings() { this.post({ command: 'openSettings' }); }

  private post(m: any) { this.view?.webview.postMessage(m); }
  private pushSessions() { this.post({ command: 'sessionList', sessions: this.sessions.listSessions() }); }

  private async onMessage(m: any) {
    switch (m.command) {
      case 'ready': this.pushSessions(); break;
      case 'newSession': await vscode.commands.executeCommand('flashCode.newChat'); break;
      case 'openSession': await vscode.commands.executeCommand('flashCode.openSession', m.id); break;
      case 'renameSession': this.sessions.renameSession(m.id, m.title); break;
      case 'deleteSession': this.sessions.deleteSession(m.id); UsageTracker.instance?.clearSession(m.id); break;
      case 'openDashboard': DashboardController.show(this.ctx); break;
      case 'getSettings': this.sendSettings(this.providers.activeId()); break;
      case 'selectProvider': this.sendSettings(m.provider); break;
      case 'saveSettings': await this.saveSettings(m.settings || {}); break;
      case 'getUsage': this.pushUsage(); break;
      case 'clearUsage': UsageTracker.instance?.clear(); this.pushUsage(); break;
    }
  }

  private pushUsage() { if (UsageTracker.instance) this.post({ command: 'usageData', usage: UsageTracker.instance.snapshot() }); }

  private async cfg(key: string, value: any) { await vscode.workspace.getConfiguration('flashCode').update(key, value, true); }

  private sendSettings(providerId: string) {
    const c = vscode.workspace.getConfiguration('flashCode');
    const provider = this.providers.get(providerId) ?? this.providers.getActive();
    const id = provider.id;
    this.post({
      command: 'settingsData',
      settings: {
        provider: id,
        model: c.get<string>(`${id}.model`) || provider.defaultModel(),
        models: this.providers.modelsFor(id),
        builtinModels: provider.models(),
        apiKeys: id === 'ollama' ? [] : this.secrets.getKeys(id),
        ollamaUrl: c.get<string>('ollama.url') || 'http://localhost:11434',
        ollamaModel: c.get<string>('ollama.model') || 'qwen3-coder',
        ollamaNumCtx: c.get<number>('ollama.numCtx') ?? 8192,
        nvidiaUrl: c.get<string>('nvidia.url') || 'https://integrate.api.nvidia.com/v1',
        defaultMode: c.get<string>('mode') || 'ask',
        defaultEffort: c.get<string>('effort') || 'medium',
      },
      keyStatuses: this.providers.keyStatuses(id),
    });
  }

  private async saveSettings(s: any) {
    const id: string = s.provider || 'gemini';
    await this.cfg('provider', id);
    if (s.model) await this.cfg(`${id}.model`, s.model);
    if (Array.isArray(s.customModels)) {
      const obj = { ...(vscode.workspace.getConfiguration('flashCode').get<Record<string, string[]>>('customModels') || {}) };
      obj[id] = s.customModels;
      await this.cfg('customModels', obj);
    }
    if (Array.isArray(s.apiKeys) && id !== 'ollama') await this.secrets.setKeys(id, s.apiKeys);
    if (s.ollamaUrl) await this.cfg('ollama.url', s.ollamaUrl);
    if (s.ollamaModel) await this.cfg('ollama.model', s.ollamaModel);
    if (s.ollamaNumCtx) await this.cfg('ollama.numCtx', parseInt(String(s.ollamaNumCtx), 10) || 8192);
    if (s.nvidiaUrl) await this.cfg('nvidia.url', s.nvidiaUrl);
    if (s.defaultMode) await this.cfg('mode', s.defaultMode);
    if (s.defaultEffort) await this.cfg('effort', s.defaultEffort);
    this.providers.rebuild();
    this.sendSettings(id);
    vscode.window.showInformationMessage('Flash Code settings saved.');
  }

  refresh() { this.pushSessions(); }
}
