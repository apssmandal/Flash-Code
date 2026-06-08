import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { sendMessage } from './backends/backendManager';
import { Msg, EFFORT, GenConfig } from './backends/types';
import { getActiveFileContent, getProjectTree, getSelectedText, getAllFiles, getVisibleFilesContent } from './fileManager';
import { SessionProvider } from './sessionProvider';
import { SidebarProvider } from './sidebarProvider';
import { AgentRunner } from './agentRunner';
import { AgentCore } from './agent/agentCore';
import { computeSideBySide } from './diffUtils';
import { parseEdits, applyEdits } from './editUtils';
import { chatKey, summaryKey, lastKey } from './storage';
import { getProfileByRole } from './subagents/registry';

interface Snap { path: string; content: string; }

const EDIT_RULES =
    'OUTPUT FORMAT — All code modifications must use standard XML blocks. Do NOT output whole files in your chat responses:\n'
    + '• CREATE new file:\n'
    + '  <create path="rel/path">COMPLETE runnable file content with all imports, functions, and boilerplate</create>\n'
    + '• EDIT existing file (use SEARCH/REPLACE pairs):\n'
    + '  <edit path="rel/path">\n'
    + '  <<<<<<< SEARCH\n'
    + '  exact existing lines, copied verbatim including indentation and spaces\n'
    + '  =======\n'
    + '  the new replacing lines\n'
    + '  >>>>>>> REPLACE\n'
    + '  </edit>\n\n'
    + 'EDIT RULES & PRINCIPLES:\n'
    + '1. Change ONLY the affected lines. Do NOT include unchanged functions or classes in your replace content.\n'
    + '2. The SEARCH block must match character-for-character exactly. Add 1-3 surrounding context lines if needed to ensure uniqueness.\n'
    + '3. Batch your tool operations: emit all <read_file> or <edit>/<create> tags in a single response rather than sequentially.\n'
    + '4. Make your prose extremely concise (at most two short sentences of intent). Avoid greetings, preambles, and apologies.\n'
    + '5. User is in control: for crucial decisions (tech stacks, naming conventions, layouts, design patterns), stop and ask the user using the <ask_user> question tag. Only proceed once they choose.';

const CODING_PROMPT = 'You are "Flash Code", a state-of-the-art AI assistant inside the user\'s VS Code workspace. '
    + 'To read a file, output: <read_file path="rel/path"/> — you will then receive its text context. '
    + 'Batch your read operations in a single response to conserve API rate limits.\n\n' + EDIT_RULES;

const PLANNING_PROMPT = 'You are "Flash Code" in PLANNING mode, an expert software architect.\n\n'
    + 'RULES:\n'
    + '1. Formulate a detailed, structured implementation plan using markdown. Do NOT write or modify files (no <edit> or <create> tags).\n'
    + '2. Read workspace files as needed using <read_file path="rel/path"/> to discover structural requirements.\n'
    + '3. Present decisions and tradeoffs. For crucial architecture or layout choices, ask the user using the <ask_user> selection block and wait for their input.';

const SUMMARIZE_PROMPT = 'Summarize the following conversation between a user and a coding assistant into a concise '
    + 'context note (>=200 words). Preserve decisions, file names, requirements, and unresolved TODOs. Output only the summary.';

export class ChatPanel {
    public static cur: ChatPanel | undefined;
    public static sidebar: SidebarProvider | undefined;
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

    public static createOrShow(ctx: vscode.ExtensionContext, sp: SessionProvider) {
        if (ChatPanel.cur) { ChatPanel.cur._p.reveal(undefined, true); return; }
        const p = vscode.window.createWebviewPanel('flashCode', 'Flash Code',
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media')] });
        ChatPanel.cur = new ChatPanel(p, ctx, sp);
    }

    private constructor(p: vscode.WebviewPanel, ctx: vscode.ExtensionContext, sp: SessionProvider) {
        this._p = p; this._ctx = ctx; this._sp = sp;
        this._sid = Date.now().toString();
        this._p.webview.html = fs.readFileSync(path.join(ctx.extensionUri.fsPath, 'media', 'chat.html'), 'utf-8');
        this._p.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'resources', 'icon.svg');

        const cfg = vscode.workspace.getConfiguration('flashCode');
        this._mode = cfg.get<string>('mode') || 'ask';
        this._effort = cfg.get<string>('effort') || 'medium';

        this._agent = new AgentRunner({
            post: (m) => this.post(m),
            send: (messages, onChunk) => sendMessage(messages, onChunk, { config: this._cfg(), onKeyStatus: (s) => ChatPanel.sidebar?.pushKeyStatus(s) }),
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
        });

        const last = ctx.globalState.get<string>(lastKey());
        if (last) this.loadSession(last);

        this.post({ command: 'setBadge', text: (cfg.get('defaultBackend') === 'ollama' ? 'ollama' : cfg.get('gemini.model')) as string });
        this.post({ command: 'restoreSettings', mode: this._mode, effort: this._effort });

        this._p.webview.onDidReceiveMessage(async (m) => {
            switch (m.command) {
                case 'sendMessage':
                    await this._send(m.text, m.attachments || []);
                    break;
                case 'spawnSubagent': await this._spawnSubagent(m.role, m.task); break;
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
                    this._gen++;
                    this._cancel = true;
                    this._busy = false;
                    this._agent.cancel();
                    for (const resolve of this._diffResolvers.values()) resolve(false);
                    this._diffResolvers.clear();
                    for (const resolve of this._cmdResolvers.values()) resolve(false);
                    this._cmdResolvers.clear();
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

    public newChat() {
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
    private async _applyEdits(text: string, groupIdx: number) {
        const ws = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!ws) return;
        const edits = parseEdits(text);
        for (const e of edits) {
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

    private async _send(userText: string, attachments: any[] = []) {
        if (this._busy) return;
        this._busy = true;
        const gen = ++this._gen;
        this._cancel = false;

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

        // Autonomous mode → hand off to the agent loop.
        if (this._mode === 'autonomous') {
            this._h.push(userMsg);
            const userMsgIdx = this._h.length - 1;
            this.post({ command: 'tagLastUser', idx: userMsgIdx });
            this.post({ command: 'agentStart' });
            const autonomousThinkNote = this._thinking ? '\n\n[SYSTEM NOTE: The user has enabled "Think" mode. You MUST think deeply and systematically step-by-step inside <think>...</think> before executing tools or making decisions to ensure the highest quality outcome.]' : '';
            const mappedHistory = this._mapHistoryForLLM(this._h);
            const finalText = await this._agent.run(fullUser + autonomousThinkNote, mappedHistory.slice(0, -1));
            if (this._gen !== gen) return; // cancelled / superseded
            if (finalText) this._h.push({ role: 'assistant', content: finalText });
            if (this._h.length > 12) await this._summarize(this._h.length);
            this._save();
            this._busy = false;
            return;
        }

        const mp = this._mode === 'plan' ? PLANNING_PROMPT : CODING_PROMPT;

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
            + (this._summary ? '\n\nConversation summary so far:\n' + this._summary : '')
            + treeBlock + fileContext
            + (sel ? '\nSelected:\n```\n' + sel + '\n```' : '');

        this._h.push(userMsg);
        const userMsgIdx = this._h.length - 1;
        this.post({ command: 'tagLastUser', idx: userMsgIdx });
        this.post({ command: 'startResponse', msgIdx: this._h.length });

        const mappedHistory = this._mapHistoryForLLM(this._h);
        const work: Msg[] = [{ role: 'system', content: sys }, ...mappedHistory.slice(-8)];
        try {
            for (let iter = 0; iter < 4; iter++) {
                let full = '';
                const { text, backend } = await sendMessage(work, (c) => { if (this._gen === gen) { full += c; this.post({ command: 'streamChunk', text: full }); } },
                    { config: this._cfg(), images: iter === 0 ? imgs : [], onKeyStatus: (s) => ChatPanel.sidebar?.pushKeyStatus(s) });
                if (this._gen !== gen) return; // cancelled or superseded — leave the new turn alone

                // Let the model read files it asks for (bounded), then continue.
                const reads = this._parseReads(text);
                if (reads.length && this._parseEditsLen(text) === 0 && iter < 3) {
                    const results = await this._readFiles(reads);
                    if (this._gen !== gen) return;
                    work.push({ role: 'assistant', content: text }, { role: 'user', content: '[file contents]\n' + results });
                    continue;
                }

                this._h.push({ role: 'assistant', content: text });
                if (this._mode !== 'plan') await this._applyEdits(text, userMsgIdx);
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

        const subagent = new AgentRunner({
            post: (msg) => {
                if (msg.command === 'agentStatus') {
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
                    this.post({ command: 'agentProgress', id, log: `[Plan] ${JSON.stringify(msg.tasks)}` });
                } else if (msg.command === 'agentProse') {
                    this.post({ command: 'agentProgress', id, log: msg.text });
                } else if (msg.command === 'agentError') {
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
            }, { config: this._cfg(), onKeyStatus: (s) => ChatPanel.sidebar?.pushKeyStatus(s) }),
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
        }, profile.systemPrompt + `\n\nYour specific task: "${task}".`);

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
            this.post({ command: 'agentFinish', id, success: false, log: `\nError: ${e.message}` });
            this.post({ command: 'agentError', message: e.message });
        } finally {
            this._busy = false;
            this.post({ command: 'agentDone' });
        }
    }
}
