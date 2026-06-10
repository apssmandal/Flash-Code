import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { sendMessage } from './backends/backendManager';
import { Msg, EFFORT, GenConfig } from './backends/types';
import { getActiveFileContent, getProjectTree, getSelectedText, getAllFiles, getVisibleFilesContent } from './fileManager';
import { SessionProvider } from './sessionProvider';
import { AgentRunner, getAgentPrompt } from './agentRunner';
import { AgentCore } from './agent/agentCore';
import { computeSideBySide } from './diffUtils';
import { parseEdits, applyEdits } from './editUtils';
import { chatKey, summaryKey, lastKey } from './storage';
import { getProfileByRole } from './subagents/registry';
import { TaskDispatcher } from './taskOrchestrator';
import { RulesEngine } from './rulesEngine';
import { 
    CODING_PROMPT, PLANNING_PROMPT, SUMMARIZE_PROMPT, TRIAGE_PROMPT,
    CHITCHAT_PROMPT, DEBUGGING_PROMPT, CODE_REVIEW_PROMPT, 
    TEST_GENERATION_PROMPT, REFACTORING_PROMPT, DOCUMENTATION_PROMPT, 
    ONBOARDING_PROMPT, DEPENDENCY_UPDATE_PROMPT, PERFORMANCE_PROMPT, SECURITY_PROMPT 
} from './prompts';
interface Snap { path: string; content: string; }

export interface ISidebar {
    pushKeyStatus(s: any): void;
    openSettings(): void;
}

export class ChatPanel {
    public static cur: ChatPanel | undefined;
    public static sidebar: ISidebar | undefined;
    private _p: vscode.WebviewPanel;
    private _h: Msg[] = [];
    private _sid: string;
    private _snaps: Map<number, Snap[]> = new Map();
    private _dis: vscode.Disposable[] = [];
    private _ctx: vscode.ExtensionContext;
    private _sp: SessionProvider;
    private _agentCore: AgentCore = new AgentCore();
    private _mode: string = 'ask';            // ask | auto-edit | plan | autonomous
    private _effort: string = 'medium';
    private _thinking: boolean = false;
    private _busy: boolean = false;
    private _cancel: boolean = false;
     private _gen: number = 0;
    private _summary: string = '';
    private _treeHash: string = '';
    private _pendingDiffs: Map<string, { newContent: string; oldContent: string; msgIdx: number }> = new Map();
    private _diffResolvers: Map<string, (v: boolean) => void> = new Map();
    private _cmdResolvers: Map<string, (v: boolean) => void> = new Map();
    private _agent: AgentRunner;
    private _subagents: { id?: string, runner: AgentRunner, abort: AbortController }[] = [];

    public static createOrShow(ctx: vscode.ExtensionContext, sp: SessionProvider) {
        if (ChatPanel.cur) { ChatPanel.cur._p.reveal(undefined, true); return; }
        const p = vscode.window.createWebviewPanel('flashCode', 'Flash Code',
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media')] });
        ChatPanel.cur = new ChatPanel(p, ctx, sp);
        ChatPanel.cur._initHtml();
    }

    private async _initHtml() {
        try {
            const uri = vscode.Uri.joinPath(this._ctx.extensionUri, 'media', 'chat.html');
            const data = await vscode.workspace.fs.readFile(uri);
            this._p.webview.html = Buffer.from(data).toString('utf-8');
        } catch (e) {
            this._p.webview.html = `<html><body><h1>Failed to load UI</h1></body></html>`;
        }
    }

    private constructor(p: vscode.WebviewPanel, ctx: vscode.ExtensionContext, sp: SessionProvider) {
        this._p = p; this._ctx = ctx; this._sp = sp;
        this._sid = Date.now().toString();
        this._p.webview.html = '<html><body><h3>Loading Flash Code UI...</h3></body></html>';
        this._p.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'resources', 'icon.svg');

        const cfg = vscode.workspace.getConfiguration('flashCode');
        this._mode = cfg.get<string>('mode') || 'ask';
        this._effort = cfg.get<string>('effort') || 'medium';

        this._agent = new AgentRunner({
            post: (m) => this.post(m),
            send: (messages, onChunk) => sendMessage(messages, onChunk, { config: this._cfg(), onKeyStatus: (s) => ChatPanel.sidebar?.pushKeyStatus(s), signal: this._abortController?.signal }),
            workspaceUri: () => vscode.workspace.workspaceFolders?.[0]?.uri,
            getMode: () => this._mode,
            recordSnapshot: (fp, old) => { const idx = this._h.length; const sn = this._snaps.get(idx) || []; sn.push({ path: fp, content: old }); this._snaps.set(idx, sn); },
            askCommand: (cmd) => {
                const cmdId = Math.random().toString(36).substring(7);
                this.post({ command: 'agentAskCommand', cmdId, cmd });
                return new Promise<boolean>((resolve) => {
                    this._cmdResolvers.set(cmdId, resolve);
                });
            },
            registerDiffResolver: (diffId, resolve) => {
                this._diffResolvers.set(diffId, resolve);
            },
            askCode: (lang, code) => {
                const cmdId = Math.random().toString(36).substring(7);
                this.post({ command: 'agentAskCode', cmdId, lang, code });
                return new Promise<boolean>((resolve) => {
                    this._cmdResolvers.set(cmdId, resolve);
                });
            }
        }, getAgentPrompt());

        const last = ctx.globalState.get<string>(lastKey());
        if (last) this.loadSession(last);

        this.post({ command: 'setBadge', text: (cfg.get('defaultBackend') === 'ollama' ? 'ollama' : cfg.get('gemini.model')) as string });
        this.post({ command: 'restoreSettings', mode: this._mode, effort: this._effort });

        this._p.webview.onDidReceiveMessage(async (m) => {
            switch (m.command) {
                case 'ready': {
                    const cfg = vscode.workspace.getConfiguration('flashCode');
                    this.post({ command: 'setBadge', text: (cfg.get('defaultBackend') === 'ollama' ? 'ollama' : cfg.get('gemini.model')) as string });
                    this.post({ command: 'restoreSettings', mode: this._mode, effort: this._effort });
                    this.post({ command: 'restoreChat', messages: this._h });
                    break;
                }
                case 'sendMessage':
                    await this._send(m.text, m.attachments || []);
                    break;
                case 'spawnSubagent': await this._spawnSubagent(m.role, m.task); break;
                case 'killSubagent': {
                    const subId = m.id;
                    const a = TaskDispatcher.getInstance().agents.get(subId);
                    if (a && a.status !== 'Completed' && a.status !== 'Error') {
                        TaskDispatcher.getInstance().updateAgent(subId, 'Error', 'Aborted by user');
                        TaskDispatcher.getInstance().removeAgent(subId);
                    }
                    const idx = this._subagents.findIndex(s => s.id === subId);
                    if (idx !== -1) {
                        this._subagents[idx].abort.abort();
                        this._subagents[idx].runner.cancel();
                        this._subagents.splice(idx, 1);
                    }
                    this.post({ command: 'agentFinish', id: subId, success: false, log: '\n[System] Aborted by user.' });
                    break;
                }
                case 'newChat': this.newChat(); break;
                case 'uploadFile': await this._upload(); break;
                case 'addContext': await this._addCtx(); break;
                case 'switchBackend': vscode.commands.executeCommand('flashCode.switchBackend'); break;
                case 'slashCommand': await this._slash(m.cmd); break;
                case 'rollback': await this._rollback(m.msgIdx); break;
                case 'setMode': this._mode = m.mode; vscode.workspace.getConfiguration('flashCode').update('mode', m.mode, true); break;
                case 'setEffort': this._effort = m.level; vscode.workspace.getConfiguration('flashCode').update('effort', m.level, true); break;
                case 'setThinking': this._thinking = m.value; break;
                case 'pasteClipboard': { const clip = await vscode.env.clipboard.readText(); if (clip) this.post({ command: 'addAttachmentToUI', attachment: { type: 'file', name: 'clipboard.txt', content: clip, ext: 'txt' } }); break; }
                case 'browseWeb': { const url = await vscode.window.showInputBox({ prompt: 'Enter a URL to fetch as context', placeHolder: 'https://…' }); if (url) await this._fetchUrl(url); break; }
                case 'acceptDiff': await this._acceptDiff(m.path, false, m.diffId); break;
                case 'acceptDiffAlways': await this._acceptDiff(m.path, true, m.diffId); break;
                case 'rejectDiff': this._rejectDiff(m.path, m.diffId); break;
                case 'tellClaude': this._rejectDiff(m.path, m.diffId); await this._send(m.text, []); break;
                case 'cancel':
                case 'agentCancel':
                    this._cancelAll();
                    break;
                case 'agentUserInput': this._agent.resolveUserInput(m.value); break;
                case 'agentAcceptCommand': {
                    const resolve = this._cmdResolvers.get(m.cmdId);
                    if (resolve) {
                        this._cmdResolvers.delete(m.cmdId);
                        resolve(true);
                    }
                    break;
                }
                case 'agentRejectCommand': {
                    const resolve = this._cmdResolvers.get(m.cmdId);
                    if (resolve) {
                        this._cmdResolvers.delete(m.cmdId);
                        resolve(false);
                    }
                    break;
                }
                case 'openInTab': { const langMap: Record<string,string> = { mermaid:'markdown', md:'markdown', js:'javascript', ts:'typescript', py:'python' }; const doc = await vscode.workspace.openTextDocument({ content: m.code || '', language: langMap[m.lang] || m.lang || 'plaintext' }); await vscode.window.showTextDocument(doc, { preview: false }); break; }
                case 'openFile': {
                    if (m.path) {
                        try {
                            if (/^https?:\/\//i.test(m.path)) {
                                vscode.env.openExternal(vscode.Uri.parse(m.path));
                                break;
                            }
                            let uri: vscode.Uri;
                            if (m.path.startsWith('file://')) {
                                uri = vscode.Uri.parse(m.path);
                            } else {
                                const ws = vscode.workspace.workspaceFolders?.[0]?.uri;
                                if (!ws) {
                                    vscode.window.showErrorMessage('No workspace open to resolve relative path.');
                                    break;
                                }
                                uri = vscode.Uri.joinPath(ws, m.path);
                            }
                            const doc = await vscode.workspace.openTextDocument(uri);
                            await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.One });
                        } catch (e: any) {
                            vscode.window.showErrorMessage('Error opening file: ' + e.message);
                        }
                    }
                    break;
                }
                case 'openSettings': await this._openSidebarSettings(); break;
                case 'switchModel': await this._openSidebarSettings(); break;
            }
        }, null, this._dis);
        this._p.onDidDispose(() => { ChatPanel.cur = undefined; this._dis.forEach(d => d.dispose()); }, null, this._dis);
    }

    public post(m: any) { this._p.webview.postMessage(m); }

    /** Reveal the sidebar view and open its settings panel (models + API keys). */
    private async _openSidebarSettings() {
        try { await vscode.commands.executeCommand('flashCode.sessions.focus'); } catch {}
        ChatPanel.sidebar?.openSettings();
    }
    private _cfg(): GenConfig { return EFFORT[this._effort] || EFFORT.medium; }

    public getSessionId(): string {
        return this._sid;
    }

    public newChat() {
        this._cancelAll();
        this._sid = Date.now().toString(); this._h = []; this._snaps.clear(); this._summary = ''; this._treeHash = '';
        this._ctx.globalState.update(lastKey(), this._sid);
        this.post({ command: 'clearChat' });
    }

    public loadSession(id: string) {
        const msgs = this._ctx.globalState.get<Msg[]>(chatKey(id), []);
        this._sid = id; this._h = msgs; this._summary = this._ctx.globalState.get<string>(summaryKey(id), '');
        this._ctx.globalState.update(lastKey(), id);
        this.post({ command: 'restoreChat', messages: msgs });
    }

    private _save() {
        this._ctx.globalState.update(chatKey(this._sid), this._h);
        this._ctx.globalState.update(summaryKey(this._sid), this._summary);
        this._ctx.globalState.update(lastKey(), this._sid);
        const title = this._h.find(m => m.role === 'user')?.content.slice(0, 40) || 'New chat';
        this._sp.save({ id: this._sid, title, date: new Date().toLocaleDateString(), count: this._h.length });
    }

    public async sendCurrentFile() {
        const f = getActiveFileContent();
        if (!f) { vscode.window.showWarningMessage('No active file.'); return; }
        this.post({ command: 'addAttachmentToUI', attachment: { type: 'file', name: f.relPath, content: f.content, ext: f.lang } });
    }

    private async _upload() {
        const uris = await vscode.window.showOpenDialog({ canSelectMany: true, filters: { 'All': ['*'] } });
        if (!uris?.length) return;
        for (const uri of uris) {
            const data = await vscode.workspace.fs.readFile(uri);
            const name = path.basename(uri.fsPath);
            const ext = path.extname(name).slice(1);
            this.post({ command: 'addAttachmentToUI', attachment: { type: 'file', name, content: Buffer.from(data).toString('utf-8'), ext } });
        }
    }

    private async _fetchUrl(url: string) {
        if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
        try {
            const r = await fetch(url);
            if (!r.ok) { vscode.window.showErrorMessage('Fetch failed: ' + r.status); return; }
            const html = await r.text();
            // crude HTML → text: drop scripts/styles and tags, collapse whitespace
            const text = html
                .replace(/<script[\s\S]*?<\/script>/gi, '')
                .replace(/<style[\s\S]*?<\/style>/gi, '')
                .replace(/<[^>]+>/g, ' ')
                .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                .replace(/\s+/g, ' ').trim().slice(0, 12000);
            this.post({ command: 'addAttachmentToUI', attachment: { type: 'file', name: url, content: text, ext: 'txt' } });
        } catch (e: any) { vscode.window.showErrorMessage('Fetch error: ' + e.message); }
    }

    private async _addCtx() {
        const files = await getAllFiles(); // full, sorted list — no 50 cap
        const pick = await vscode.window.showQuickPick(files, { placeHolder: 'Select a workspace file' });
        if (!pick) return;
        const ws = vscode.workspace.workspaceFolders?.[0]?.uri; if (!ws) return;
        const data = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(ws, pick));
        this.post({ command: 'addAttachmentToUI', attachment: { type: 'file', name: pick, content: Buffer.from(data).toString('utf-8'), ext: path.extname(pick).slice(1) } });
    }

    private async _slash(cmd: string) {
        switch (cmd) {
            case 'new': this.newChat(); break;
            case 'clear': this._h = []; this._summary = ''; this._save(); this.post({ command: 'clearChat' }); break;
            case 'model': vscode.commands.executeCommand('flashCode.switchModel'); break;
            case 'file': this.sendCurrentFile(); break;
            case 'add': await this._upload(); break;
            case 'context': await this._addCtx(); break;
            case 'plan': this._mode = 'plan'; this.post({ command: 'restoreSettings', mode: 'plan' }); break;
            case 'auto': this._mode = 'autonomous'; this.post({ command: 'restoreSettings', mode: 'autonomous' }); break;
            case 'ask': this._mode = 'ask'; this.post({ command: 'restoreSettings', mode: 'ask' }); break;
            case 'effort': { const lvl = await vscode.window.showQuickPick(['low', 'medium', 'high', 'xhigh', 'max'], { placeHolder: 'Effort level' }); if (lvl) { this._effort = lvl; this.post({ command: 'restoreSettings', effort: lvl }); } break; }
            case 'compact': await this._compact(); break;
            case 'help': this.post({ command: 'showNotice', text: '/new /clear /compact /file /add /context /plan /auto /ask /model /effort' }); break;
        }
    }

    private async _compact() {
        if (this._h.length < 4) return;
        this.post({ command: 'workNotice', text: 'Compacting context' });
        await this._summarize(this._h.length);
        this._save();
        this.post({ command: 'showNotice', text: 'Context compacted.' });
    }

    /** Summarize the oldest messages into the rolling summary, keep the last ~8 verbatim. */
    private async _summarize(upTo: number) {
        const keep = 12;
        const cut = Math.max(0, Math.min(upTo, this._h.length) - keep);
        if (cut <= 0) return;
        const old = this._h.slice(0, cut);
        const text = (this._summary ? 'Earlier summary:\n' + this._summary + '\n\n' : '')
            + old.map(m => m.role + ': ' + m.content.slice(0, 400)).join('\n');
        try {
            const { text: sum } = await sendMessage(
                [{ role: 'system', content: SUMMARIZE_PROMPT }, { role: 'user', content: text }],
                () => {}, { config: EFFORT.low }
            );
            this._summary = sum.trim();
            this._h = this._h.slice(cut); // drop summarized raw messages
        } catch { /* keep raw history if summarization fails */ }
    }

    /**
     * Parse <edit>/<create> blocks from an assistant response, apply them to the
     * on-disk files, and present each as a red/green diff card. `groupIdx` is the
     * user-message index so a rewind on that turn reverts these writes.
     */
    private async _applyEdits(text: string, groupIdx: number, planOnly: boolean = false) {
        const ws = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!ws) return;
        const edits = parseEdits(text);
        for (const e of edits) {
            if (planOnly && !e.path.includes('.flash/plan.md')) continue;

            const uri = vscode.Uri.joinPath(ws, e.path);
            let old = '';
            try { old = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf-8'); } catch {}
            const { content, failures } = applyEdits(old, e);
            if (failures.length && content === old) {
                this.post({ command: 'changeCard', path: e.path, summary: "couldn't match edit (search text not found)" });
                continue;
            }
            await this._presentChange(e.path, old, content, groupIdx);
        }
    }

    /** Route a computed file change: Ask → diff card + wait; Auto → write now. */
    private async _presentChange(fp: string, old: string, newContent: string, groupIdx: number) {
        if (old === newContent) return;
        const diff = computeSideBySide(old, newContent);
        if (this._mode === 'ask') {
            this._pendingDiffs.set(fp, { newContent, oldContent: old, msgIdx: groupIdx });
            this.post({ command: 'showDiff', changes: [{ path: fp, diff, badge: old ? 'Modified' : 'new' }] });
            return;
        }
        await this._writeFile(fp, newContent, old, groupIdx);
        this.post({ command: 'showDiff', changes: [{ path: fp, diff, badge: old ? 'Modified' : 'new', applied: true }] });
    }

    private async _writeFile(fp: string, code: string, old: string, msgIdx: number) {
        const ws = vscode.workspace.workspaceFolders![0].uri;
        const uri = vscode.Uri.joinPath(ws, fp);
        const sn = this._snaps.get(msgIdx) || []; sn.push({ path: fp, content: old }); this._snaps.set(msgIdx, sn);
        await vscode.workspace.fs.writeFile(uri, Buffer.from(code, 'utf-8'));
    }

    private async _acceptDiff(fp: string, always: boolean, diffId?: string) {
        if (diffId && this._diffResolvers.has(diffId)) {
            const resolve = this._diffResolvers.get(diffId);
            this._diffResolvers.delete(diffId);
            if (resolve) resolve(true);
            return;
        }
        const pend = this._pendingDiffs.get(fp);
        if (!pend) return;
        await this._writeFile(fp, pend.newContent, pend.oldContent, pend.msgIdx);
        this._pendingDiffs.delete(fp);
        if (always) { this._mode = 'auto-edit'; this.post({ command: 'restoreSettings', mode: 'auto-edit' }); }
    }

    private _rejectDiff(fp: string, diffId?: string) {
        if (diffId && this._diffResolvers.has(diffId)) {
            const resolve = this._diffResolvers.get(diffId);
            this._diffResolvers.delete(diffId);
            if (resolve) resolve(false);
            return;
        }
        this._pendingDiffs.delete(fp);
        this.post({ command: 'changeCard', path: fp, summary: 'rejected' });
    }

    private async _rollback(msgIdx: number) {
        const ws = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!ws) return;
        const ok = await vscode.window.showWarningMessage('Rewind to here? Files and chat after this point will be reverted.', { modal: true }, 'Rewind');
        if (ok !== 'Rewind') return;
        for (const [idx, sn] of this._snaps.entries()) {
            if (idx >= msgIdx) {
                for (const s of sn) {
                    const u = vscode.Uri.joinPath(ws, s.path);
                    if (s.content) await vscode.workspace.fs.writeFile(u, Buffer.from(s.content, 'utf-8'));
                    else { try { await vscode.workspace.fs.delete(u); } catch {} }
                }
                this._snaps.delete(idx);
            }
        }
        this._h = this._h.slice(0, msgIdx);
        this._save();
        this.post({ command: 'restoreChat', messages: this._h });
        vscode.window.showInformationMessage('Rewound to selected point.');
    }

    private _abortController?: AbortController;

    private async _send(userText: string, attachments: any[] = []) {
        if (this._busy) return;
        this._busy = true;
        const gen = ++this._gen;
        this._cancel = false;
        if (this._abortController) this._abortController.abort();
        this._abortController = new AbortController();

        const userMsg: Msg = { role: 'user', content: userText };
        if (attachments.length > 0) {
            userMsg.attachments = attachments;
        }

        // Build user message (with attachment file content / images).
        let fullUser = userText;
        const imgs: { mime: string; data: string }[] = [];
        for (const a of attachments) {
            if (a.type === 'file' && a.content) fullUser += '\n\nFile `' + a.name + '`:\n```' + (a.ext || '') + ':' + a.name + '\n' + a.content + '\n```';
            else if (a.type === 'image' && a.data) imgs.push({ mime: a.mime || 'image/png', data: a.data });
        }

        // Triage Gateway (Hidden Two-Pass Router)
        let triageOut = '';
        try {
            this.post({ command: 'agentStatus', text: 'Triaging request...' });
            
            let contextStr = '';
            if (this._h.length > 0) {
                const recent = this._h.slice(-4);
                contextStr = '<Session_History>\\n' + recent.map(m => m.role.toUpperCase() + ': ' + (m.content.length > 1500 ? m.content.substring(0, 1500) + '... [truncated]' : m.content)).join('\\n\\n') + '\\n</Session_History>\\n\\n';
            }
            
            const triageWork: Msg[] = [{ role: 'system', content: TRIAGE_PROMPT }, { role: 'user', content: contextStr + '<Current_Request>\\n' + fullUser + '\\n</Current_Request>' }];
            
            // Add a timeout specifically for Triage so it doesn't hang
            let triageAbort: AbortController | undefined;
            let signal = this._abortController?.signal;
            let timeoutId: NodeJS.Timeout | undefined;
            
            if (typeof AbortSignal !== 'undefined' && (AbortSignal as any).timeout) {
                // Node 17.3+ supports AbortSignal.any and timeout, but VS Code might have older Node typings, so fallback to custom
                triageAbort = new AbortController();
                const parentSignal = this._abortController?.signal;
                if (parentSignal) parentSignal.addEventListener('abort', () => triageAbort?.abort());
                timeoutId = setTimeout(() => { triageAbort?.abort(); }, 60000);
                signal = triageAbort.signal;
            }

            const res = await sendMessage(triageWork, () => {}, { config: this._cfg(), signal: signal });
            if (timeoutId) clearTimeout(timeoutId);
            triageOut = res.text;
        } catch (e: any) {
            this._busy = false;
            if (this._cancel) return;
            const errStr = e.name === 'AbortError' || e.message === 'Cancelled' ? 'Triage timed out or was cancelled.' : e.message;
            this.post({ command: 'agentStatus', text: 'Triage failed: ' + errStr });
            this.post({ command: 'error', text: errStr });
            return;
        }

        if (this._gen !== gen) return;

        // Match: <route target="X" [role="Y"] [task="Z"] />
        const routeMatch = triageOut.match(/<route\s+target="([^"]+)"(?:\s+role="([^"]*)")?(?:\s+task="([^"]*)")?\s*\/>/i);
        let directTarget: string | undefined;

        if (routeMatch) {
            const target = routeMatch[1].toUpperCase();
            if (target === 'DELEGATE') {
                const role = routeMatch[2] || 'Background Worker';
                const task = routeMatch[3] || 'Executing delegated task';
                const id = Math.random().toString(36).substring(7);

                this.post({ command: 'agentSpawn', id, role, task });
                this.post({ command: 'agentProgress', id, percentage: 10, log: `Initializing background agent [${role}]...` });

                const dispatcher = TaskDispatcher.getInstance();
                dispatcher.registerAgent(id, role, task);

                const profile = getProfileByRole(role as any) || getProfileByRole('Inspector');
                const rules = RulesEngine.getInstance().getProjectRules();
                const sysPrompt = profile.systemPrompt + (rules ? `\n\n${rules}` : '') + `\n\nYour specific task is: "${task}".`;

                const subAbort = new AbortController();
                const subagent = new AgentRunner({
                    post: (msg) => {
                        if (msg.command === 'agentStatus') {
                            dispatcher.updateAgent(id, 'Executing', msg.text);
                            this.post({ command: 'agentProgress', id, log: `[Status] ${msg.text}` });
                        } else if (msg.command === 'agentThinking') {
                            this.post({ command: 'agentProgress', id, log: `[Thinking] ${msg.text}` });
                        } else if (msg.command === 'agentToolCall') {
                            this.post({ command: 'agentProgress', id, log: `[Tool Call] <${msg.tool} detail="${msg.detail}">` });
                        } else if (msg.command === 'agentToolOutput') {
                            this.post({ command: 'agentProgress', id, log: msg.text });
                        } else if (msg.command === 'agentToolResult') {
                            this.post({ command: 'agentProgress', id, log: `[Tool Result] ${msg.success ? 'Success' : 'Failed'}: ${msg.output}` });
                        } else if (msg.command === 'agentTaskList') {
                            dispatcher.updateAgent(id, 'Planning', 'Created plan');
                            this.post({ command: 'agentProgress', id, log: `[Plan] ${JSON.stringify(msg.tasks)}` });
                        } else if (msg.command === 'agentProse') {
                            this.post({ command: 'agentProgress', id, log: msg.text });
                        } else if (msg.command === 'agentError') {
                            dispatcher.updateAgent(id, 'Error', msg.message);
                            this.post({ command: 'agentProgress', id, log: `[Error] ${msg.message}` });
                        } else if (msg.command === 'showDiff') {
                            this.post(msg);
                        } else {
                            this.post(msg);
                        }
                    },
                    send: (messages, onChunk) => sendMessage(messages, (chunk) => {
                        onChunk(chunk);
                        this.post({ command: 'agentProgress', id, log: chunk });
                    }, { config: this._cfg(), onKeyStatus: (s) => ChatPanel.sidebar?.pushKeyStatus(s), signal: subAbort.signal }),
                    workspaceUri: () => vscode.workspace.workspaceFolders?.[0]?.uri,
                    getMode: () => this._mode,
                    recordSnapshot: (fp, old) => { const idx = this._h.length; const sn = this._snaps.get(idx) || []; sn.push({ path: fp, content: old }); this._snaps.set(idx, sn); },
                    askCommand: (cmd) => {
                        const cmdId = Math.random().toString(36).substring(7);
                        this.post({ command: 'agentAskCommand', cmdId, cmd });
                        return new Promise<boolean>((resolve) => {
                            this._cmdResolvers.set(cmdId, resolve);
                        });
                    },
                    registerDiffResolver: (diffId, resolve) => {
                        this._diffResolvers.set(diffId, resolve);
                    },
                    askCode: (lang, code) => {
                        const cmdId = Math.random().toString(36).substring(7);
                        this.post({ command: 'agentAskCode', cmdId, lang, code });
                        return new Promise<boolean>((resolve) => {
                            this._cmdResolvers.set(cmdId, resolve);
                        });
                    }
                }, getAgentPrompt(profile?.defaultTools) + '\n\n' + sysPrompt, profile?.defaultTools);

                this._subagents.push({ id, runner: subagent, abort: subAbort });
                dispatcher.enqueueRequest(10, async () => {
                    const ctx = `[Context provided by parent delegator]\n\nUser Request: ${fullUser}`;
                    try {
                        const out = await subagent.run(ctx, []);
                        dispatcher.updateAgent(id, 'Completed', 'Task Finished');
                        this.post({ command: 'agentProgress', id, percentage: 100, log: 'Task Finished successfully.' });
                        this.post({ command: 'agentFinish', id, success: true, log: '\n--- Worker Finished ---' });
                        if (out) {
                            const summaryMsg = `[Subagent ${role}]: ${out}`;
                            this._h.push({ role: 'assistant', content: summaryMsg });
                            this.post({ command: 'agentProse', text: summaryMsg });
                            this._save();
                        }
                    } catch (e: any) {
                        dispatcher.updateAgent(id, 'Error', e.message);
                        this.post({ command: 'agentProgress', id, log: `Error: ${e.message}` });
                        this.post({ command: 'agentFinish', id, success: false, log: `\nError: ${e.message}` });
                    } finally {
                        this._subagents = this._subagents.filter(a => a.runner !== subagent);
                    }
                });

                const msg = `Dispatched task "${task}" to background agent **${role}**. You can monitor its progress in the agents panel.`;
                this._h.push(userMsg);
                this.post({ command: 'tagLastUser', idx: this._h.length - 1 });
                this._h.push({ role: 'assistant', content: msg });
                this.post({ command: 'startResponse', msgIdx: this._h.length });
                this.post({ command: 'streamChunk', text: msg });
                this._save();
                this._busy = false;
                return;
            } else { directTarget = target; }
        }

        

        let mp = this._mode === 'plan' ? PLANNING_PROMPT : CODING_PROMPT;
        if (directTarget === 'PLANNING_PROMPT') mp = PLANNING_PROMPT;
        else if (directTarget === 'CODING_PROMPT') mp = CODING_PROMPT;
        else if (directTarget === 'SUMMARIZE_PROMPT') mp = SUMMARIZE_PROMPT;
        else if (directTarget === 'CHITCHAT_PROMPT') mp = CHITCHAT_PROMPT;
        else if (directTarget === 'DEBUGGING_PROMPT') mp = DEBUGGING_PROMPT;
        else if (directTarget === 'CODE_REVIEW_PROMPT') mp = CODE_REVIEW_PROMPT;
        else if (directTarget === 'TEST_GENERATION_PROMPT') mp = TEST_GENERATION_PROMPT;
        else if (directTarget === 'REFACTORING_PROMPT') mp = REFACTORING_PROMPT;
        else if (directTarget === 'DOCUMENTATION_PROMPT') mp = DOCUMENTATION_PROMPT;
        else if (directTarget === 'ONBOARDING_PROMPT') mp = ONBOARDING_PROMPT;
        else if (directTarget === 'DEPENDENCY_UPDATE_PROMPT') mp = DEPENDENCY_UPDATE_PROMPT;
        else if (directTarget === 'PERFORMANCE_PROMPT') mp = PERFORMANCE_PROMPT;
        else if (directTarget === 'SECURITY_PROMPT') mp = SECURITY_PROMPT;

        
        let planContext = '';
        try {
            const ws = vscode.workspace.workspaceFolders?.[0]?.uri;
            if (ws) {
                const planUri = vscode.Uri.joinPath(ws, '.flash', 'plan.md');
                const buf = await vscode.workspace.fs.readFile(planUri);
                planContext = '\n\n[ACTIVE PLAN]\n' + Buffer.from(buf).toString('utf-8') + '\n';
            }
        } catch {}

        // Project tree only when it changed (token saver). Inject key files on first/changed turn.
        const tree = await getProjectTree();
        const treeHash = String(tree.length) + ':' + tree.slice(0, 40);
        const changed = treeHash !== this._treeHash;
        const treeBlock = changed ? ('\n\nProject:\n' + tree + await this._keyFiles()) : '\n\n(project structure unchanged)';
        this._treeHash = treeHash;

        const visibleFiles = getVisibleFilesContent();
        const sel = getSelectedText();
        let fileContext = '';
        for (const file of visibleFiles) {
            if (file.content.length < 15000) {
                fileContext += '\nVisible file ' + file.relPath + ' (edit with <edit>):\n```' + file.lang + '\n' + file.content + '\n```\n';
            } else {
                fileContext += '\nVisible file: ' + file.relPath + ' (' + file.content.split('\n').length + ' lines — select a region or attach for precise edits).\n';
            }
        }

        const thinkNote = this._thinking ? '\n\nIMPORTANT: Think deeply and thoroughly step-by-step inside <think>...</think> before formulating your final answer. Analyze edge cases, architectural impacts, and alternative solutions to arrive at the absolute best result.' : '';
        const sys = mp + thinkNote
            + `\n\nCurrent Date and Time: ${new Date().toLocaleString()}`
            + (this._summary ? '\n\nConversation summary so far:\n' + this._summary : '')
            + planContext
            + treeBlock + fileContext
            + (sel ? '\nSelected:\n```\n' + sel + '\n```' : '');

        this._h.push(userMsg);
        const userMsgIdx = this._h.length - 1;
        this.post({ command: 'tagLastUser', idx: userMsgIdx });
        this.post({ command: 'startResponse', msgIdx: this._h.length });

        let workingHistory = [...this._h];
        const rewrittenMatch = triageOut.match(/<rewritten_prompt>([\s\S]*?)<\/rewritten_prompt>/i);
        if (rewrittenMatch && rewrittenMatch[1].trim()) {
            workingHistory[userMsgIdx] = { ...workingHistory[userMsgIdx], content: `[Triage Enhanced Prompt]:\n${rewrittenMatch[1].trim()}` };
        }

        const mappedHistory = this._mapHistoryForLLM(workingHistory);
        const work: Msg[] = [{ role: 'system', content: sys }, ...mappedHistory.slice(-8)];
        try {
            for (let iter = 0; iter < 4; iter++) {
                let full = '';
                const { text, backend } = await sendMessage(work, (c) => {
                    if (this._gen === gen) {
                        full += c;
                        this.post({ command: 'streamChunk', text: full });
                        const tlMatch = /<task_list>([\s\S]*?)<\/task_list>/.exec(full);
                        if (tlMatch) {
                            try { this.post({ command: 'agentTaskList', tasks: JSON.parse(tlMatch[1].trim()) }); } catch {}
                        }
                    }
                }, { config: this._cfg(), images: iter === 0 ? imgs : [], onKeyStatus: (s) => ChatPanel.sidebar?.pushKeyStatus(s), signal: this._abortController?.signal });
                if (this._gen !== gen) return; // cancelled or superseded — leave the new turn alone

                const tlMatch = /<task_list>([\s\S]*?)<\/task_list>/.exec(text);
                if (tlMatch) {
                    try { this.post({ command: 'agentTaskList', tasks: JSON.parse(tlMatch[1].trim()) }); } catch {}
                }

                // Let the model read files it asks for (bounded), then continue.
                const reads = this._parseReads(text);
                if (reads.length && this._parseEditsLen(text) === 0 && iter < 3) {
                    const results = await this._readFiles(reads);
                    if (this._gen !== gen) return;
                    work.push({ role: 'assistant', content: text }, { role: 'user', content: '[file contents]\n' + results });
                    continue;
                }

                this._h.push({ role: 'assistant', content: text });
                if (this._mode !== 'plan') {
                    await this._applyEdits(text, userMsgIdx);
                } else {
                    // In plan mode, only allow edits to the plan file
                    await this._applyEdits(text, userMsgIdx, true);
                }
                if (this._h.length > 24) await this._summarize(this._h.length);
                this._save();
                this._busy = false;
                this.post({ command: 'endResponse', backend, msgIdx: this._h.length - 1 });
                return;
            }
            this._busy = false;
            this.post({ command: 'endResponse', backend: 'gemini', msgIdx: -1 });
        } catch (e: any) {
            if (this._gen !== gen) return;
            this._busy = false;
            const busy = /503|UNAVAILABLE|overloaded|high demand/i.test(e.message);
            this.post({ command: 'endResponse', backend: 'error', msgIdx: -1 });
            this.post({ command: 'errorCard', title: 'Error', message: e.message }); // raw, unprocessed
            if (busy) await this._offerSwitch(userText, attachments);
        }
    }

    /** On a model-busy error, ask the user whether to switch model and retry. */
    private async _offerSwitch(userText: string, attachments: any[]) {
        const cfg = vscode.workspace.getConfiguration('flashCode');
        const current = cfg.get<string>('gemini.model') || 'gemini-2.5-flash';
        
        let alt = 'gemini-2.5-flash';
        if (current === 'gemini-2.5-flash') alt = 'gemini-3-flash-preview';
        else if (current === 'gemini-3-flash-preview') alt = 'gemini-3.1-flash-lite';
        else if (current === 'gemini-3.1-flash-lite') alt = 'gemini-3.5-flash';
        const pick = await vscode.window.showWarningMessage(
            current + ' is busy. Switch to ' + alt + ' and retry?', 'Switch & retry', 'Stay');
        if (pick === 'Switch & retry') {
            await cfg.update('gemini.model', alt, true);
            this.post({ command: 'setBadge', text: alt });
            await this._send(userText, attachments);
        }
    }

    private _getFullUserText(content: string, attachments?: any[]): string {
        let full = content;
        if (attachments) {
            for (const a of attachments) {
                if (a.type === 'file' && a.content) {
                    full += '\n\nFile `' + a.name + '`:\n```' + (a.ext || '') + ':' + a.name + '\n' + a.content + '\n```';
                }
            }
        }
        return full;
    }

    private _mapHistoryForLLM(history: Msg[]): Msg[] {
        return history.map(m => {
            if (m.role === 'user') {
                return {
                    role: 'user',
                    content: this._getFullUserText(m.content, m.attachments),
                    attachments: m.attachments
                };
            }
            return m;
        });
    }

    private _parseReads(text: string): string[] {
        const out: string[] = []; let m; const rx = /<read_file\s+path=["']([^"']+)["']\s*\/?>/g;
        while ((m = rx.exec(text)) !== null) out.push(m[1].trim());
        return out;
    }
    private _parseEditsLen(text: string): number { return parseEdits(text).length; }

    /** Read a couple of orienting files (README, package.json) so the model never has to refuse. */
    private async _keyFiles(): Promise<string> {
        const ws = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!ws) return '';
        let out = '';
        for (const name of ['README.md', 'package.json']) {
            try {
                const data = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(ws, name))).toString('utf-8');
                out += '\n\n' + name + ':\n```\n' + data.slice(0, 1500) + '\n```';
            } catch {}
        }
        return out;
    }

    private async _readFiles(paths: string[]): Promise<string> {
        const ws = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!ws) return '(no workspace)';
        const parts: string[] = [];
        for (const p of paths.slice(0, 3)) {
            try {
                const data = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(ws, p))).toString('utf-8');
                parts.push('=== ' + p + ' ===\n' + data.slice(0, 6000));
            } catch { parts.push('=== ' + p + ' ===\n(not found)'); }
        }
        return parts.join('\n\n');
    }

    private async _spawnSubagent(role: string, task: string) {
        if (this._busy) return;
        this._busy = true;
        const gen = ++this._gen;
        const id = Math.random().toString(36).substring(7);
        this._cancel = false;

        this.post({ command: 'agentStart' });

        const profile = getProfileByRole(role);
        
        // --- Worktree Injection ---
        const dispatcher = TaskDispatcher.getInstance();
        const worktreePath = await dispatcher.spawnAgentWithWorktree(id, role, task); // Internally uses .flash/worktrees
        const worktreeUri = worktreePath ? vscode.Uri.file(worktreePath) : vscode.workspace.workspaceFolders?.[0]?.uri;

        const subAbort = new AbortController();
        const subagent = new AgentRunner({
            post: (msg) => {
                if (msg.command === 'agentStatus') {
                    dispatcher.updateAgent(id, 'Executing', msg.text);
                    this.post({ command: 'agentProgress', id, log: `[Status] ${msg.text}` });
                } else if (msg.command === 'agentThinking') {
                    this.post({ command: 'agentProgress', id, log: `[Thinking] ${msg.text}` });
                } else if (msg.command === 'agentToolCall') {
                    this.post({ command: 'agentProgress', id, log: `[Tool Call] <${msg.tool} detail="${msg.detail}">` });
                } else if (msg.command === 'agentToolOutput') {
                    this.post({ command: 'agentProgress', id, log: msg.text });
                } else if (msg.command === 'agentToolResult') {
                    this.post({ command: 'agentProgress', id, log: `[Tool Result] ${msg.success ? 'Success' : 'Failed'}: ${msg.output}` });
                } else if (msg.command === 'agentTaskList') {
                    dispatcher.updateAgent(id, 'Planning', 'Created plan');
                    this.post({ command: 'agentProgress', id, log: `[Plan] ${JSON.stringify(msg.tasks)}` });
                } else if (msg.command === 'agentProse') {
                    this.post({ command: 'agentProgress', id, log: msg.text });
                } else if (msg.command === 'agentError') {
                    dispatcher.updateAgent(id, 'Error', msg.message);
                    this.post({ command: 'agentProgress', id, log: `[Error] ${msg.message}` });
                } else if (msg.command === 'showDiff') {
                    this.post(msg);
                } else {
                    this.post(msg);
                }
            },
            send: (messages, onChunk) => sendMessage(messages, (chunk) => {
                onChunk(chunk);
                this.post({ command: 'agentProgress', id, log: chunk });
            }, { config: this._cfg(), onKeyStatus: (s) => ChatPanel.sidebar?.pushKeyStatus(s), signal: subAbort.signal }),
            workspaceUri: () => worktreeUri,
            getMode: () => this._mode,
            recordSnapshot: (fp, old) => { const idx = this._h.length; const sn = this._snaps.get(idx) || []; sn.push({ path: fp, content: old }); this._snaps.set(idx, sn); },
            askCommand: (cmd) => {
                const cmdId = Math.random().toString(36).substring(7);
                this.post({ command: 'agentAskCommand', cmdId, cmd });
                return new Promise<boolean>((resolve) => {
                    this._cmdResolvers.set(cmdId, resolve);
                });
            },
            registerDiffResolver: (diffId, resolve) => {
                this._diffResolvers.set(diffId, resolve);
            },
            askCode: (lang, code) => {
                const cmdId = Math.random().toString(36).substring(7);
                this.post({ command: 'agentAskCode', cmdId, lang, code });
                return new Promise<boolean>((resolve) => {
                    this._cmdResolvers.set(cmdId, resolve);
                });
            }
        }, getAgentPrompt(profile?.defaultTools) + '\n\n' + profile?.systemPrompt + `\n\nYour specific task: "${task}".`, profile?.defaultTools);

        this._subagents.push({ runner: subagent, abort: this._abortController! });

        const text = `Initialize specialized agent [${profile.role}] to solve: "${task}"`;
        const subagentPrompt = profile.systemPrompt + `\n\nYour specific task: "${task}".`;

        const subHistory: Msg[] = [
            { role: 'system', content: subagentPrompt },
            { role: 'user', content: `Start execution of task: "${task}"` }
        ];

        this.post({ command: 'agentSpawn', id, role: profile.role, task });
        this.post({ command: 'agentProgress', id, percentage: 10, log: `Initializing specialized subagent [${profile.role}]...` });

        try {
            this.post({ command: 'agentProgress', id, percentage: 30, log: 'Scanning workspace structures...' });

            const finalText = await subagent.run(text, subHistory);

            if (this._gen !== gen) return;

            dispatcher.updateAgent(id, 'Awaiting_Approval', 'Ready for review and merge.');

            this.post({ command: 'agentProgress', id, percentage: 100, log: 'Finalizing subagent outputs...' });
            this.post({ command: 'agentFinish', id, success: true, log: '\n--- Worker Finished ---' });

            if (finalText) {
                const summaryMsg = `[Subagent ${profile.role}]: ${finalText}`;
                this._h.push({ role: 'assistant', content: summaryMsg });
                this.post({ command: 'agentProse', text: summaryMsg });
            }

            if (this._h.length > 24) await this._summarize(this._h.length);
            this._save();
        } catch (e: any) {
            dispatcher.updateAgent(id, 'Error', `Failed: ${e.message}`);
            this.post({ command: 'agentFinish', id, success: false, log: `\nError: ${e.message}` });
            this.post({ command: 'agentError', message: e.message });
        } finally {
            this._subagents = this._subagents.filter(a => a.runner !== subagent);
            this._busy = false;
            this.post({ command: 'agentDone' });
        }
    }

    private _cancelAll() {
        this._gen++;
        this._cancel = true;
        this._busy = false;
        this._abortController?.abort();
        this._agent.cancel();
        this._subagents.forEach(a => { a.abort.abort(); a.runner.cancel(); });
        this._subagents = [];
        for (const resolve of this._diffResolvers.values()) resolve(false);
        this._diffResolvers.clear();
        for (const resolve of this._cmdResolvers.values()) resolve(false);
        this._cmdResolvers.clear();
        
        // Kill all active background sub-agents
        for (const [agentId, state] of TaskDispatcher.getInstance().agents.entries()) {
            if (state.status !== 'Completed' && state.status !== 'Error') {
                TaskDispatcher.getInstance().updateAgent(agentId, 'Error', 'Cancelled by user');
                TaskDispatcher.getInstance().removeAgent(agentId);
                this.post({ command: 'agentFinish', id: agentId, success: false, log: '\n[System] Cancelled by user.' });
            }
        }
    }
}
