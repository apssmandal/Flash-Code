/**
 * ChatController — owns the chat webview (the ORIGINAL Flash Code chat.html) and
 * drives it with the new multi-provider engine. It translates the engine's
 * AgentEvents into the original webview message vocabulary (startResponse/
 * streamChunk/closeBubble, agentToolCall, showDiff, agentSpawn, …) and maps the
 * webview's commands back onto the engine.
 */

import * as vscode from 'vscode';
import { ProviderRegistry } from '../providers/registry';
import { SecretStore } from '../secrets';
import { EFFORT } from '../providers/types';
import { AgentLoop } from '../core/agentLoop';
import { buildDefaultRegistry } from '../core/tools';
import { HostToolContext, HostToolPlane } from './hostToolContext';
import { buildWebviewHtml } from './webviewHtml';
import { DashboardController } from './dashboardController';
import { agentHub } from './agentHub';
import { SessionManager } from '../session/sessionManager';
import { sessionEvents } from '../session/sessionEvents';
import { buildSystemPrompt, buildChatPrompt, SUMMARIZE_PROMPT } from '../prompts/system';
import { getSubagentProfile } from '../prompts/subagents';
import { classifyIntent } from '../core/triage';
import { classifyCommand } from '../core/commandClass';
import { meterProvider } from '../providers/metered';
import { UsageTracker } from './usageTracker';
import type { Provider } from '../providers/types';
import { RulesEngine } from '../rulesEngine';
import { getProjectTree, getKeyFiles, getActiveFileContent, getAllFiles } from '../fileManager';
import { computeSideBySide } from '../diffUtils';
import type { AgentEvent, AgentMode } from '../core/events';
import { createLogger } from '../core/logger';

const log = createLogger('chat');
/** Read-only tools for the "codebase" route (understand, don't change). */
const READ_ONLY_TOOLS = ['read_file', 'list_files', 'search_files', 'read_dir', 'get_file_info', 'read_json', 'git_status', 'git_diff', 'git_log', 'git_blame', 'fetch_url', 'search_web', 'ask_user'];

export class ChatController {
  static current: ChatController | undefined;

  private panel: vscode.WebviewPanel;
  private session: SessionManager;
  private registry = buildDefaultRegistry();
  private mode: AgentMode;
  private effort: string;
  private busy = false;
  private abort?: AbortController;
  private loop?: AgentLoop;
  private activeTurn = 0;
  private resolvers = new Map<string, (v: any) => void>();
  private disposables: vscode.Disposable[] = [];
  // streaming bubble state
  private streaming = false;
  // messages sent while busy, run in order when the current task finishes
  private queue: { text: string; attachments: any[] }[] = [];
  // command-permission categories the user allowed for the CURRENT thread
  // (one user message = one thread); reset whenever a new message starts.
  private threadAllowedCmds = new Set<string>();
  // cmdId -> command category, so "allow for thread" knows what to remember
  private pendingCmds = new Map<string, string>();

  static show(ctx: vscode.ExtensionContext, providers: ProviderRegistry, secrets: SecretStore) {
    if (ChatController.current) { ChatController.current.panel.reveal(undefined, true); return; }
    const panel = vscode.window.createWebviewPanel('flashCode', 'Flash Code', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, {
      enableScripts: true, retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media')],
    });
    ChatController.current = new ChatController(panel, ctx, providers, secrets);
  }

  private constructor(panel: vscode.WebviewPanel, private ctx: vscode.ExtensionContext, private providers: ProviderRegistry, private secrets: SecretStore) {
    this.panel = panel;
    this.session = new SessionManager(ctx);
    const cfg = vscode.workspace.getConfiguration('flashCode');
    this.mode = (cfg.get<string>('mode') as AgentMode) || 'ask';
    this.effort = cfg.get<string>('effort') || 'medium';
    panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'resources', 'icon.svg');
    panel.webview.html = buildWebviewHtml(panel.webview, ctx.extensionUri, 'chat');
    panel.webview.onDidReceiveMessage((m: any) => this.onMessage(m), null, this.disposables);
    this.disposables.push(sessionEvents.event(() => this.sendSessions()));
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  openSession(id: string) {
    this.session.load(id);
    this.post({ command: 'restoreChat', messages: this.session.uiTurns });
    this.panel.reveal(undefined, true);
  }

  /** Start a fresh session and clear the chat (sidebar + command + composer "+"). */
  newChat() {
    this.session.newChat();
    this.streaming = false;
    this.post({ command: 'clearChat' });
    this.panel.reveal(undefined, true);
  }

  sendCurrentFile() {
    const f = getActiveFileContent();
    if (!f) { vscode.window.showWarningMessage('No active file.'); return; }
    this.post({ command: 'addAttachmentToUI', attachment: { type: 'file', name: f.relPath, content: f.content, ext: f.lang } });
  }

  private post(m: any) { this.panel.webview.postMessage(m); }
  private dispose() { ChatController.current = undefined; this.abort?.abort(); this.disposables.forEach((d) => d.dispose()); }

  // ----------------- inbound (webview → host) -----------------
  private async onMessage(m: any) {
    switch (m.command) {
      case 'ready':
        this.post({ command: 'restoreSettings', mode: this.mode, effort: this.effort });
        this.post({ command: 'setBadge', text: this.providers.activeModel() });
        this.post({ command: 'restoreChat', messages: this.session.uiTurns });
        break;
      case 'sendMessage': return this.handleSend(m.text, m.attachments || []);
      case 'cancel': case 'agentCancel': return this.cancel();
      case 'killSubagent': return this.cancel();
      case 'setMode': this.mode = m.mode; await this.cfgUpdate('mode', m.mode); break;
      case 'setEffort': this.effort = m.level; await this.cfgUpdate('effort', m.level); break;
      case 'setThinking': break; // reasoning is provider-driven now
      case 'slashCommand': return this.slash(m.cmd);
      case 'newChat': this.newChat(); break;
      case 'agentUserInput': this.resolve('ask_user', m.value); break;
      case 'agentAcceptCommand': this.resolve(m.cmdId, true); break;
      case 'agentAcceptCommandThread': { const cat = this.pendingCmds.get(m.cmdId); if (cat) this.threadAllowedCmds.add(cat); this.resolve(m.cmdId, true); break; }
      case 'agentRejectCommand': this.resolve(m.cmdId, false); break;
      case 'acceptDiff': this.resolve('diff:' + m.diffId, true); break;
      case 'acceptDiffAlways': this.resolve('diff:' + m.diffId, true); this.mode = 'auto-edit'; await this.cfgUpdate('mode', 'auto-edit'); this.post({ command: 'restoreSettings', mode: 'auto-edit' }); break;
      case 'rejectDiff': this.resolve('diff:' + m.diffId, false); break;
      case 'tellClaude': this.resolve('diff:' + m.diffId, false); await this.handleSend(m.text, []); break;
      case 'openFile': return this.openFile(m.path);
      case 'openInTab': { const doc = await vscode.workspace.openTextDocument({ content: m.code || '', language: m.lang || 'plaintext' }); await vscode.window.showTextDocument(doc, { preview: false }); break; }
      case 'openSettings': case 'switchModel': await this.focusSidebarSettings(); break;
      case 'spawnSubagent': await this.handleSpawn(m.role, m.task); break;
      case 'uploadFile': return this.uploadFiles();
      case 'addContext': return this.addContext();
      case 'pasteClipboard': { const t = await vscode.env.clipboard.readText(); if (t) this.post({ command: 'addAttachmentToUI', attachment: { type: 'file', name: 'clipboard.txt', content: t, ext: 'txt' } }); break; }
      case 'browseWeb': return this.browseWeb();
    }
  }

  private async cfgUpdate(key: string, value: any) { await vscode.workspace.getConfiguration('flashCode').update(key, value, true); }
  private resolve(id: string, value: any) { this.pendingCmds.delete(id); const r = this.resolvers.get(id); if (r) { this.resolvers.delete(id); r(value); } }
  private root(): vscode.Uri | undefined { return vscode.workspace.workspaceFolders?.[0]?.uri; }
  /** Active provider wrapped so every model call's token usage is recorded against the current session. */
  private metered(): Provider {
    return meterProvider(this.providers.getActive(), (provider, model, i, o) =>
      UsageTracker.instance?.record(this.session.sessionId, provider, model, i, o));
  }
  private sendSessions() { /* the sidebar owns the session list; nothing to push to the chat panel */ }
  private async focusSidebarSettings() { try { await vscode.commands.executeCommand('flashCode.sessions.focus'); await vscode.commands.executeCommand('flashCode.openSettings'); } catch { /* ignore */ } }

  // ----------------- run + event adapter -----------------
  private async handleSend(text: string, attachments: any[]) {
    if (!text || !text.trim()) return;
    if (this.busy) { // queue and run after the current task finishes
      this.queue.push({ text, attachments });
      this.post({ command: 'showNotice', text: 'Queued — runs after the current task.' });
      return;
    }
    this.busy = true;
    this.streaming = false;
    this.abort = new AbortController();
    // A new user message starts a new thread → forget any per-thread command grants.
    this.threadAllowedCmds.clear();
    this.pendingCmds.clear();
    this.activeTurn = this.session.addUser(text, attachments);
    this.session.save(); // index + list the session immediately (named from this message)
    const fullText = this.userWithAttachments(text, attachments);
    const history = this.session.history().slice(0, -1);

    try {
      const provider = this.metered();
      const model = this.providers.activeModel();
      const recent = history.slice(-4).map((m) => `${m.role}: ${m.content.slice(0, 200)}`);
      const route = await classifyIntent(provider, model, text, recent, this.abort.signal);

      if (route === 'general') {
        await this.answerDirect(provider, model, fullText, history);
      } else {
        const rules = RulesEngine.getInstance().getProjectRules();
        const tree = await getProjectTree();
        const keyFiles = await getKeyFiles();
        const system = buildSystemPrompt({ mode: this.mode, projectTree: tree, rules, summary: this.session.rollingSummary, keyFiles });
        this.loop = new AgentLoop({
          provider, registry: this.registry, ctx: new HostToolContext(this.plane()),
          systemPrompt: system, model, genConfig: EFFORT[this.effort] ?? EFFORT.medium,
          allowedTools: route === 'codebase' ? READ_ONLY_TOOLS : undefined,
          maxIterations: route === 'codebase' ? 12 : 40,
          verifyCompletion: true, // don't stop until the objective is genuinely met
        });
        const result = await this.loop.run(fullText, history, this.abort.signal);
        if (result) this.session.addAssistant(result);
      }
      this.session.save();
      await this.maybeCompact(provider);
    } catch (e: any) {
      log.error(e?.message);
      this.post({ command: 'agentError', message: e?.message ?? String(e) });
    } finally {
      this.busy = false;
      this.drainQueue();
    }
  }

  /** "general" route — stream a direct answer with no tools, no codebase context. */
  private async answerDirect(provider: ReturnType<ProviderRegistry['getActive']>, model: string, fullText: string, history: any[]) {
    const sys = buildChatPrompt({ summary: this.session.rollingSummary });
    const messages = [...history, { role: 'user' as const, content: fullText }];
    let out = '';
    for await (const ev of provider.stream({ model, system: sys, messages, genConfig: EFFORT[this.effort] ?? EFFORT.medium }, this.abort?.signal)) {
      if (ev.type === 'text') { out += ev.text; this.emit({ type: 'prose', text: out }); }
    }
    if (out.trim()) { this.emit({ type: 'prose', text: out.trim() }); this.session.addAssistant(out.trim()); }
    this.emit({ type: 'done' });
  }

  private drainQueue() {
    if (this.busy || this.queue.length === 0) return;
    const next = this.queue.shift()!;
    void this.handleSend(next.text, next.attachments);
  }

  private userWithAttachments(text: string, attachments: any[]): string {
    let full = text;
    for (const a of attachments ?? []) {
      if (a.type === 'file' && a.content) full += `\n\n<attached_file name="${a.name}">\n${a.content}\n</attached_file>`;
    }
    return full;
  }

  /** Translate engine AgentEvents → original chat.html message vocabulary. */
  private emit(ev: AgentEvent) {
    switch (ev.type) {
      case 'status': break; // activity shown via streaming bubble + tool cards
      case 'thinking': break;
      case 'prose':
        if (!this.streaming) { this.post({ command: 'startResponse', msgIdx: this.session.uiTurns.length }); this.streaming = true; }
        this.post({ command: 'streamChunk', text: ev.text });
        break;
      case 'tasks': this.post({ command: 'agentTaskList', tasks: ev.tasks }); break;
      case 'tool_start': this.closeBubble(); this.post({ command: 'agentToolCall', tool: ev.tool, detail: ev.detail }); break;
      case 'tool_output': break; // output is shown on tool_result
      case 'tool_result': this.post({ command: 'agentToolResult', tool: ev.tool, success: ev.ok, output: ev.summary }); break;
      case 'diff': this.closeBubble(); this.post({ command: 'showDiff', diffId: ev.diffId, changes: [{ path: ev.path, diff: ev.rows, badge: ev.badge, applied: ev.applied }] }); break;
      case 'ask_user': this.closeBubble(); this.post({ command: 'agentAskUser', questions: ev.questions }); break;
      case 'ask_command': this.post({ command: 'agentAskCommand', cmdId: ev.cmdId, cmd: ev.command, threadLabel: ev.threadLabel }); break;
      case 'ask_code': this.post({ command: 'agentAskCode', cmdId: ev.cmdId, lang: ev.lang, code: ev.code, threadLabel: ev.threadLabel }); break;
      case 'spawn': this.closeBubble(); this.post({ command: 'agentSpawn', id: ev.id, role: ev.role, task: ev.task }); this.toDashboard(ev); break;
      case 'progress': this.post({ command: 'agentProgress', id: ev.id, percentage: ev.percentage, log: ev.log }); this.toDashboard(ev); break;
      case 'finish': this.post({ command: 'agentFinish', id: ev.id, success: ev.success, log: ev.log }); this.toDashboard(ev); break;
      case 'error': this.closeBubble(); this.post({ command: 'agentError', message: ev.message }); break;
      case 'done': this.closeBubble(); this.post({ command: 'agentDone' }); break;
    }
  }

  private closeBubble() { if (this.streaming) { this.post({ command: 'closeBubble' }); this.streaming = false; } }
  private toDashboard(ev: AgentEvent) { DashboardController.record(ev); agentHub.fire(ev); }

  private cancel() {
    this.abort?.abort(); this.loop?.cancel();
    this.queue = [];
    for (const r of this.resolvers.values()) r(false);
    this.resolvers.clear();
    this.pendingCmds.clear();
    this.busy = false;
    this.post({ command: 'agentDone' });
  }

  // ----------------- host tool plane -----------------
  private plane(): HostToolPlane {
    return {
      emit: (ev) => this.emit(ev),
      mode: () => this.mode,
      root: () => this.root(),
      recordSnapshot: (rel, old, existed) => this.session.snapshot(this.activeTurn, rel, old, existed),
      askApproval: (kind, detail) => this.askApproval(kind, detail),
      askUser: (questions) => this.askUser(questions),
      presentDiff: (path, oldText, newText) => this.presentDiff(path, oldText, newText),
      spawn: (role, task) => this.spawn(role, task),
    };
  }

  private askApproval(kind: 'command' | 'code' | 'write', detail: string): Promise<boolean> {
    const cfgAuto = !!vscode.workspace.getConfiguration('flashCode').get<boolean>('autoApprove');
    // Running commands/code in the project ALWAYS asks (any mode) unless the
    // user explicitly opts into autoApprove. Only file writes follow the mode.
    const auto = kind === 'write'
      ? (this.mode === 'autonomous' || this.mode === 'auto-edit' || cfgAuto)
      : cfgAuto;
    if (auto) return Promise.resolve(true);

    const cmdId = rid();
    let threadLabel: string | undefined;
    // command/code can be pre-approved for the rest of the thread by category;
    // file writes always follow the per-message prompt above.
    if (kind !== 'write') {
      const cls = classifyCommand(detail);
      if (this.threadAllowedCmds.has(cls.category)) return Promise.resolve(true);
      this.pendingCmds.set(cmdId, cls.category);
      threadLabel = cls.label;
    }
    this.emit(kind === 'code'
      ? { type: 'ask_code', cmdId, lang: 'sh', code: detail, threadLabel }
      : { type: 'ask_command', cmdId, command: detail, threadLabel });
    return new Promise((res) => this.resolvers.set(cmdId, res));
  }

  private askUser(questions: any[]): Promise<string> {
    this.emit({ type: 'ask_user', questions });
    return new Promise((res) => this.resolvers.set('ask_user', res));
  }

  private async presentDiff(path: string, oldText: string, newText: string): Promise<boolean> {
    if (oldText === newText) return true;
    const rows = computeSideBySide(oldText, newText, 100000); // uncollapsed; webview collapses with expanders
    const badge = oldText ? 'Modified' : 'new';
    const root = this.root();
    if (!root) return false;
    const existed = oldText.length > 0;

    if (this.mode === 'ask') {
      const diffId = rid();
      this.emit({ type: 'diff', diffId, path, rows, badge });
      const ok = await new Promise<boolean>((res) => this.resolvers.set('diff:' + diffId, res));
      if (!ok) return false;
    }
    this.session.snapshot(this.activeTurn, path, oldText, existed);
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, path), Buffer.from(newText, 'utf-8'));
    if (this.mode !== 'ask') this.emit({ type: 'diff', path, rows, badge, applied: true });
    return true;
  }

  // ----------------- subagents -----------------
  /** `/agent <role> <task>` — spawn a subagent directly (always lands on the board). */
  private async handleSpawn(role: string, task: string) {
    if (this.busy || !role || !task) return;
    this.busy = true;
    this.streaming = false;
    this.abort = new AbortController();
    this.threadAllowedCmds.clear();
    this.pendingCmds.clear();
    this.activeTurn = this.session.addUser(`/agent ${role} ${task}`, []);
    this.session.save(); // index + list immediately
    try {
      const out = await this.spawn(role, task);
      if (out) { this.session.addAssistant(out); this.post({ command: 'agentProse', text: out }); }
      this.session.save();
    } catch (e: any) {
      this.post({ command: 'agentError', message: e?.message ?? String(e) });
    } finally {
      this.busy = false;
      this.post({ command: 'agentDone' });
      this.drainQueue();
    }
  }

  private async spawn(role: string, task: string): Promise<string> {
    const id = rid();
    const profile = getSubagentProfile(role);
    this.emit({ type: 'spawn', id, role: profile.role, task });
    const provider = this.metered();
    const childPlane: HostToolPlane = {
      ...this.plane(),
      emit: (ev) => {
        if (ev.type === 'status') this.emit({ type: 'progress', id, log: `[status] ${ev.text}` });
        else if (ev.type === 'prose') this.emit({ type: 'progress', id, log: ev.text });
        else if (ev.type === 'tool_start') this.emit({ type: 'progress', id, log: `[tool] ${ev.tool} ${ev.detail}` });
        else if (ev.type === 'tool_result') this.emit({ type: 'progress', id, log: `[result] ${ev.summary}` });
        else if (ev.type !== 'done') this.emit(ev);
      },
    };
    const sys = buildSystemPrompt({ mode: this.mode }) + '\n\n' + profile.systemPrompt + `\n\nYour task: "${task}".`;
    const loop = new AgentLoop({
      provider, registry: this.registry, ctx: new HostToolContext(childPlane),
      systemPrompt: sys, model: this.providers.activeModel(), genConfig: EFFORT[this.effort] ?? EFFORT.medium,
      allowedTools: profile.tools.length ? profile.tools : undefined,
    });
    try {
      const out = await loop.run(`Begin: ${task}`, [], this.abort?.signal);
      this.emit({ type: 'finish', id, success: true });
      return out || '(no output)';
    } catch (e: any) {
      this.emit({ type: 'finish', id, success: false, log: e?.message });
      return `Subagent ${role} failed: ${e?.message}`;
    }
  }

  /** Keep this many recent model messages verbatim; older context lives in the summary. */
  private static readonly COMPACT_KEEP = 8;
  /** Auto-compact once the model history grows past this. */
  private static readonly COMPACT_AT = 24;

  /** Auto-compaction after a turn: only fires once history has actually grown. */
  private async maybeCompact(provider: ReturnType<ProviderRegistry['getActive']>): Promise<void> {
    if (this.session.modelMessageCount <= ChatController.COMPACT_AT) return;
    await this.compactNow(provider);
  }

  /**
   * Real compaction: roll the prior summary + the conversation into a fresh
   * summary, then DROP all but the last COMPACT_KEEP model messages so the
   * window genuinely shrinks. Returns a short status for UI feedback.
   */
  private async compactNow(provider: ReturnType<ProviderRegistry['getActive']>): Promise<{ dropped: number; before: number; after: number; freedTokens: number }> {
    const before = this.session.modelMessageCount;
    if (before <= ChatController.COMPACT_KEEP) return { dropped: 0, before, after: before, freedTokens: 0 };
    try {
      const oldSummaryTokens = Math.ceil(this.session.rollingSummary.length / 4);
      const prior = this.session.rollingSummary ? `Earlier summary:\n${this.session.rollingSummary}\n\n` : '';
      const convo = prior + this.session.uiTurns.map((t) => `${t.role.toUpperCase()}: ${t.content.slice(0, 600)}`).join('\n');
      let summary = '';
      for await (const ev of provider.stream({ model: this.providers.activeModel(), system: SUMMARIZE_PROMPT, messages: [{ role: 'user', content: convo }], genConfig: EFFORT.low })) {
        if (ev.type === 'text') summary += ev.text;
      }
      if (!summary.trim()) return { dropped: 0, before, after: before, freedTokens: 0 };
      const { dropped, freedTokens } = this.session.compactInto(summary.trim(), ChatController.COMPACT_KEEP);
      this.session.save();
      // Net reduction per future call ≈ history tokens dropped minus the growth of the injected summary.
      const summaryGrowth = Math.max(0, Math.ceil(summary.trim().length / 4) - oldSummaryTokens);
      const net = Math.max(0, freedTokens - summaryGrowth);
      return { dropped, before, after: this.session.modelMessageCount, freedTokens: net };
    } catch (e: any) {
      log.warn('compaction failed: ' + e?.message);
      return { dropped: 0, before, after: before, freedTokens: 0 };
    }
  }

  // ----------------- slash + context -----------------
  private async slash(cmd: string) {
    switch (cmd) {
      case 'new': this.session.newChat(); this.post({ command: 'clearChat' }); this.sendSessions(); break;
      case 'clear': this.session.clear(); this.post({ command: 'clearChat' }); break;
      case 'compact': {
        const r = await this.compactNow(this.metered());
        this.post({ command: 'showNotice', text: r.dropped > 0 ? `Context compacted — folded ${r.dropped} messages into a summary, freeing ~${r.freedTokens.toLocaleString()} tokens of context (${r.before} → ${r.after} kept).` : 'Nothing to compact yet — the conversation is still short.' });
        break;
      }
      case 'file': this.sendCurrentFile(); break;
      case 'add': await this.uploadFiles(); break;
      case 'context': await this.addContext(); break;
      case 'plan': this.mode = 'plan'; await this.cfgUpdate('mode', 'plan'); this.post({ command: 'restoreSettings', mode: 'plan' }); break;
      case 'auto': this.mode = 'autonomous'; await this.cfgUpdate('mode', 'autonomous'); this.post({ command: 'restoreSettings', mode: 'autonomous' }); break;
      case 'ask': this.mode = 'ask'; await this.cfgUpdate('mode', 'ask'); this.post({ command: 'restoreSettings', mode: 'ask' }); break;
      case 'model': await this.focusSidebarSettings(); break;
      default: break;
    }
  }

  private async uploadFiles() {
    const uris = await vscode.window.showOpenDialog({ canSelectMany: true });
    for (const uri of uris ?? []) {
      const data = await vscode.workspace.fs.readFile(uri);
      const name = uri.path.split('/').pop() || 'file';
      this.post({ command: 'addAttachmentToUI', attachment: { type: 'file', name, content: Buffer.from(data).toString('utf-8'), ext: name.split('.').pop() } });
    }
  }

  private async addContext() {
    const files = await getAllFiles();
    const pick = await vscode.window.showQuickPick(files, { placeHolder: 'Select a workspace file' });
    if (!pick) return;
    const root = this.root(); if (!root) return;
    const data = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, pick));
    this.post({ command: 'addAttachmentToUI', attachment: { type: 'file', name: pick, content: Buffer.from(data).toString('utf-8'), ext: pick.split('.').pop() } });
  }

  private async browseWeb() {
    const url = await vscode.window.showInputBox({ prompt: 'URL to fetch as context', placeHolder: 'https://…' });
    if (!url) return;
    try {
      const res = await fetch(/^https?:\/\//i.test(url) ? url : 'https://' + url);
      const text = (await res.text()).replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 12000);
      this.post({ command: 'addAttachmentToUI', attachment: { type: 'file', name: url, content: text, ext: 'txt' } });
    } catch (e: any) { vscode.window.showErrorMessage('Fetch failed: ' + e.message); }
  }

  private async openFile(p: string) {
    try {
      if (/^https?:\/\//i.test(p)) { vscode.env.openExternal(vscode.Uri.parse(p)); return; }
      const root = this.root(); if (!root) return;
      const uri = p.startsWith('file://') ? vscode.Uri.parse(p) : vscode.Uri.joinPath(root, p);
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true });
    } catch (e: any) { vscode.window.showErrorMessage('Open failed: ' + e.message); }
  }
}

function rid(): string { return Math.random().toString(36).slice(2, 9); }
