/** Mission Control dashboard (original kanban dashboard.html). Maintains live
 * subagent states from the agent hub and posts updateState to the webview. */
import * as vscode from 'vscode';
import { buildWebviewHtml } from './webviewHtml';
import { agentHub } from './agentHub';
import type { AgentEvent } from '../core/events';

interface AgentState { id: string; role: string; objective: string; progress: string; status: string; }

export class DashboardController {
  static current: DashboardController | undefined;
  private static states = new Map<string, AgentState>();

  private panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  static show(ctx: vscode.ExtensionContext) {
    if (DashboardController.current) { DashboardController.current.panel.reveal(); return; }
    const panel = vscode.window.createWebviewPanel('flashCodeDashboard', 'Mission Control', vscode.ViewColumn.Active, {
      enableScripts: true, retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media')],
    });
    DashboardController.current = new DashboardController(panel, ctx);
  }

  /** Fold an agent event into the shared state map (also drives a live panel). */
  static record(ev: AgentEvent) {
    const states = DashboardController.states;
    if (ev.type === 'spawn') states.set(ev.id, { id: ev.id, role: ev.role, objective: ev.task, progress: 'Starting…', status: 'Executing' });
    else if (ev.type === 'progress') { const s = states.get(ev.id); if (s) { s.progress = (ev.log || s.progress).slice(0, 200); } }
    else if (ev.type === 'finish') { const s = states.get(ev.id); if (s) { s.status = 'Completed'; s.progress = ev.success ? 'Done.' : ('Failed: ' + (ev.log || '')); } }
    DashboardController.current?.update();
  }

  private constructor(panel: vscode.WebviewPanel, ctx: vscode.ExtensionContext) {
    this.panel = panel;
    panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'resources', 'icon.svg');
    panel.webview.html = buildWebviewHtml(panel.webview, ctx.extensionUri, 'dashboard');
    panel.webview.onDidReceiveMessage((m: any) => {
      if (m.command === 'ready') this.update();
      else if (m.command === 'approveTask') vscode.window.showInformationMessage('Subagents merge into the workspace automatically; no manual approval needed.');
    }, null, this.disposables);
    this.disposables.push(agentHub.event(() => this.update()));
    panel.onDidDispose(() => { DashboardController.current = undefined; this.disposables.forEach((d) => d.dispose()); }, null, this.disposables);
  }

  private update() {
    this.panel.webview.postMessage({ command: 'updateState', agents: [...DashboardController.states.values()] });
  }
}
