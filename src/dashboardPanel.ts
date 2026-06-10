import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { TaskDispatcher, AgentState } from './taskOrchestrator';

export class DashboardPanel {
    public static cur: DashboardPanel | undefined;
    private _p: vscode.WebviewPanel;
    private _ctx: vscode.ExtensionContext;
    private _disposables: vscode.Disposable[] = [];

    public static createOrShow(ctx: vscode.ExtensionContext) {
        if (DashboardPanel.cur) { 
            DashboardPanel.cur._p.reveal(undefined, true); 
            return; 
        }
        const p = vscode.window.createWebviewPanel(
            'flashCodeDashboard', 
            'Mission Control',
            { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
            { 
                enableScripts: true, 
                retainContextWhenHidden: true, 
                localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media')] 
            }
        );
        DashboardPanel.cur = new DashboardPanel(p, ctx);
    }

    private constructor(p: vscode.WebviewPanel, ctx: vscode.ExtensionContext) {
        this._p = p; 
        this._ctx = ctx;

        this._p.webview.html = this.getHtml();
        this._p.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'resources', 'icon.svg');

        // Listen for state changes from the TaskDispatcher
        TaskDispatcher.getInstance().onStateChange = () => this.syncState();

        this._p.webview.onDidReceiveMessage(async m => {
            if (m.command === 'ready') {
                this.syncState();
            } else if (m.command === 'approveTask') {
                await TaskDispatcher.getInstance().approveAgentTask(m.id);
            }
        }, null, this._disposables);

        this._p.onDidDispose(() => this.dispose(), null, this._disposables);
    }

    private getHtml(): string {
        try {
            return fs.readFileSync(path.join(this._ctx.extensionUri.fsPath, 'media', 'dashboard.html'), 'utf-8');
        } catch {
            return `<html><body><h1>Dashboard UI not found</h1></body></html>`;
        }
    }

    private syncState() {
        const agents = Array.from(TaskDispatcher.getInstance().agents.values());
        this.post({ command: 'updateState', agents });
    }

    public post(msg: any) {
        this._p.webview.postMessage(msg);
    }

    public dispose() {
        DashboardPanel.cur = undefined;
        this._p.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) d.dispose();
        }
    }
}
