/**
 * Flash Code extension entry point. Wires SecretStorage, the provider registry,
 * project-rules engine, the chat panel/sidebar/dashboard, and commands.
 */

import * as vscode from 'vscode';
import { migrateLegacy } from './storage';
import { SecretStore, KeyedProvider } from './secrets';
import { ProviderRegistry, KEYED_PROVIDERS } from './providers/registry';
import { RulesEngine } from './rulesEngine';
import { ChatController } from './host/chatController';
import { SidebarProvider } from './host/sidebarProvider';
import { DashboardController } from './host/dashboardController';
import { UsageTracker } from './host/usageTracker';
import { configureLogger, createLogger } from './core/logger';
import { getActiveFileContent } from './fileManager';

let registry: ProviderRegistry;
let secrets: SecretStore;
let sidebar: SidebarProvider;

export async function activate(ctx: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('Flash Code');
  configureLogger({ appendLine: (l) => output.appendLine(l) }, 'info');
  const log = createLogger('extension');

  migrateLegacy(ctx);
  UsageTracker.init(ctx);
  RulesEngine.getInstance().activate(ctx);

  secrets = new SecretStore(ctx.secrets);
  await secrets.init(KEYED_PROVIDERS);
  await secrets.migrateFromConfig(ctx);
  registry = new ProviderRegistry(secrets);
  sidebar = new SidebarProvider(ctx, registry, secrets);

  ctx.subscriptions.push(
    output,
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewId, sidebar),
    vscode.commands.registerCommand('flashCode.open', () => ChatController.show(ctx, registry, secrets)),
    vscode.commands.registerCommand('flashCode.newChat', () => { ChatController.show(ctx, registry, secrets); ChatController.current?.newChat(); }),
    vscode.commands.registerCommand('flashCode.openSession', (id: string) => { ChatController.show(ctx, registry, secrets); if (id) ChatController.current?.openSession(id); }),
    vscode.commands.registerCommand('flashCode.openDashboard', () => DashboardController.show(ctx)),
    vscode.commands.registerCommand('flashCode.sendFile', () => sendCurrentFile(ctx)),
    vscode.commands.registerCommand('flashCode.switchProvider', () => switchProvider()),
    vscode.commands.registerCommand('flashCode.switchModel', () => switchModel()),
    vscode.commands.registerCommand('flashCode.manageKeys', () => manageKeys()),
    vscode.commands.registerCommand('flashCode.openSettings', () => sidebar.openSettings()),
  );

  log.info('Flash Code activated');
}

export function deactivate() { /* nothing to clean up */ }

async function switchProvider() {
  const pick = await vscode.window.showQuickPick(registry.list().map((p) => ({ label: p.label, id: p.id })), { placeHolder: 'Select AI provider' });
  if (!pick) return;
  await vscode.workspace.getConfiguration('flashCode').update('provider', pick.id, true);
  registry.rebuild();
  sidebar.refresh();
  vscode.window.showInformationMessage(`Flash Code provider: ${pick.label}`);
}

async function switchModel() {
  const active = registry.getActive();
  const pick = await vscode.window.showQuickPick(active.models(), { placeHolder: `Model for ${active.label}` });
  if (!pick) return;
  await vscode.workspace.getConfiguration('flashCode').update(`${active.id}.model`, pick, true);
  registry.rebuild();
}

async function manageKeys() {
  const keyed: KeyedProvider[] = [...KEYED_PROVIDERS];
  const provider = await vscode.window.showQuickPick(keyed, { placeHolder: 'Provider to set key(s) for' });
  if (!provider) return;
  const hint = provider === 'gemini' ? 'Comma-separate multiple free-tier keys for rotation' : 'Paste your API key';
  const value = await vscode.window.showInputBox({ prompt: `${provider} API key(s)`, placeHolder: hint, password: true });
  if (value === undefined) return;
  const keys = value.split(',').map((k) => k.trim()).filter(Boolean);
  await secrets.setKeys(provider, keys);
  registry.rebuild();
  sidebar.refresh();
  vscode.window.showInformationMessage(`Saved ${keys.length} key(s) for ${provider} to Secret Storage.`);
}

function sendCurrentFile(ctx: vscode.ExtensionContext) {
  const f = getActiveFileContent();
  if (!f) { vscode.window.showWarningMessage('No active file.'); return; }
  ChatController.show(ctx, registry, secrets);
  vscode.window.showInformationMessage(`Attach ${f.relPath} in the chat composer.`);
}

