import * as vscode from 'vscode';
import { ChatPanel } from './chatPanel';
import { SessionProvider } from './sessionProvider';
import { SidebarProvider } from './sidebarProvider';
import { migrateLegacy } from './storage';
import { DashboardPanel } from './dashboardPanel';
import { RulesEngine } from './rulesEngine';

export function activate(context: vscode.ExtensionContext) {
    migrateLegacy(context);

    RulesEngine.getInstance().activate(context);

    const sp = new SessionProvider(context);
    const sidebar = new SidebarProvider(context, sp);
    ChatPanel.sidebar = sidebar;

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(SidebarProvider.viewId, sidebar),
        vscode.commands.registerCommand('flashCode.open', () => ChatPanel.createOrShow(context, sp)),
        vscode.commands.registerCommand('flashCode.openDashboard', () => DashboardPanel.createOrShow(context)),
        vscode.commands.registerCommand('flashCode.newChat', () => { ChatPanel.createOrShow(context, sp); ChatPanel.cur?.newChat(); }),
        vscode.commands.registerCommand('flashCode.sendFile', () => { ChatPanel.createOrShow(context, sp); ChatPanel.cur?.sendCurrentFile(); }),
        vscode.commands.registerCommand('flashCode.switchBackend', async () => {
            const cfg = vscode.workspace.getConfiguration('flashCode');
            const pick = await vscode.window.showQuickPick(['ollama', 'gemini'], { placeHolder: 'Current: ' + cfg.get('defaultBackend') });
            if (pick) { await cfg.update('defaultBackend', pick, true); ChatPanel.cur?.post({ command: 'setBadge', text: pick }); sidebar.pushSettings(); }
        }),
        vscode.commands.registerCommand('flashCode.switchModel', async () => {
            const cfg = vscode.workspace.getConfiguration('flashCode');
            const pick = await vscode.window.showQuickPick(
                [{ label: 'Gemini 2.5 Flash', m: 'gemini-2.5-flash' }, { label: 'Gemini 3 Flash', m: 'gemini-3-flash-preview' }, { label: 'Gemini 3.1 Flash Lite', m: 'gemini-3.1-flash-lite' }, { label: 'Gemini 3.5 Flash', m: 'gemini-3.5-flash' }],
                { placeHolder: 'Current: ' + cfg.get('gemini.model') }
            );
            if (pick) { await cfg.update('gemini.model', pick.m, true); await cfg.update('defaultBackend', 'gemini', true); ChatPanel.cur?.post({ command: 'setBadge', text: pick.m }); sidebar.pushSettings(); }
        }),
        vscode.commands.registerCommand('flashCode.openSession', (id: string) => { ChatPanel.createOrShow(context, sp); ChatPanel.cur?.loadSession(id); })
    );
}

export function deactivate() {}
