import * as vscode from 'vscode';
import { Msg } from './backends/types';
import { getProjectTree, getAllFiles } from './fileManager';
import { computeSideBySide } from './diffUtils';
import { applyEdits } from './editUtils';
import { getProfileByRole } from './subagents/registry';
import { spawn } from 'child_process';
import { stripVTControlCharacters } from 'util';
import { TaskDispatcher } from './taskOrchestrator';
import { RulesEngine } from './rulesEngine';
import { EDIT_PROTOCOLS, TOOL_DEFINITIONS, AUTONOMOUS_DIRECTIVES, WEB_DESIGN_DIRECTIVES } from './prompts';

export function getAgentPrompt(allowedTools?: string[]): string {
    let toolsDef = TOOL_DEFINITIONS;
    if (allowedTools && allowedTools.length > 0) {
        const lines = TOOL_DEFINITIONS.split('\n');
        const allowedLines = lines.filter(line => {
            const match = line.match(/<([a-zA-Z0-9_]+)/);
            if (!match) return true;
            return allowedTools.includes(match[1]);
        });
        toolsDef = allowedLines.join('\n');
    }
    
    return `You are "Flash Code", a state-of-the-art autonomous coding agent executing directly inside a VS Code workspace.
You solve tasks systematically by planning, invoking workspace tools, observing results, self-correcting, and cooperating with background agents.

=========================================
OUTPUT FORMAT & XML TOOL TAGS
=========================================
Your output can contain text (prose) and tool execution tags. All tool tags MUST be raw, unescaped XML (NEVER wrap tool tags in markdown code blocks).

<Tool_Registry>
` + toolsDef + `
  <status>a short progress note (e.g., "Compiling source files...")</status>
  <task_list>[{"id":"1","desc":"task","status":"pending"}]</task_list>
  <spawn_agent role="Architect|Inspector|QA|Stylist|Sculptor" task="subtask description"/>
</Tool_Registry>

` + EDIT_PROTOCOLS + `

=========================================
CRITICAL OPERATIONAL RULES
=========================================
` + AUTONOMOUS_DIRECTIVES + '\n\n' + WEB_DESIGN_DIRECTIVES;
}

interface ToolCall { tool: string; attrs: Record<string, string>; body: string; raw: string; }

export interface AgentDeps {
    post: (m: any) => void;
    send: (messages: Msg[], onChunk: (t: string) => void) => Promise<{ text: string; backend: string; finishReason?: string }>;
    workspaceUri: () => vscode.Uri | undefined;
    getMode: () => string;                 // 'ask' | 'auto-edit' | 'autonomous'
    recordSnapshot: (path: string, old: string) => void;
    askCommand: (cmd: string) => Promise<boolean>;
    registerDiffResolver: (diffId: string, resolve: (v: boolean) => void) => void;
    askCode: (lang: string, code: string) => Promise<boolean>;
}

export class AgentRunner {
    private _cancelled = false;
    private _userInput?: (v: string) => void;

    constructor(private d: AgentDeps, private systemPrompt: string = getAgentPrompt(), private allowedTools?: string[]) {}

    cancel() { this._cancelled = true; this._userInput?.('[cancelled]'); }
    resolveUserInput(v: string) { this._userInput?.(v); this._userInput = undefined; }

    async run(userText: string, history: Msg[]): Promise<string> {
        this._cancelled = false;
        const tree = await getProjectTree();
        const rules = RulesEngine.getInstance().getProjectRules();
        const sys = this.systemPrompt
            + `\n\nCurrent Date and Time: ${new Date().toLocaleString()}`
            + (rules ? `\n\n${rules}` : '')
            + '\n\nProject structure:\n' + tree;
        const work: Msg[] = [...history.slice(-8), { role: 'user', content: userText }];
        let finalProse = '';
        let hasPendingTasks = false;

        try {
            for (let iter = 0; iter < 50; iter++) {
                if (this._cancelled) { this.d.post({ command: 'agentStatus', text: 'Stopped.' }); break; }

                const messages: Msg[] = [{ role: 'system', content: sys }, ...work];
                this.d.post({ command: 'agentStatus', text: 'Thinking…' });
                const { text: buf, finishReason } = await this.d.send(messages, () => { /* tokens buffered; cards render per-turn */ });
                work.push({ role: 'assistant', content: buf });

                // Render think / status / task_list segments.
                for (const t of matchAll(buf, /<think\b[^>]*>([\s\S]*?)<\/think>/g)) this.d.post({ command: 'agentThinking', text: t.trim() });
                for (const s of matchAll(buf, /<status>([\s\S]*?)<\/status>/g)) this.d.post({ command: 'agentStatus', text: s.trim() });
                const tl = /<task_list>([\s\S]*?)<\/task_list>/.exec(buf);
                if (tl) { 
                    try { 
                        const tasks = JSON.parse(tl[1].trim());
                        this.d.post({ command: 'agentTaskList', tasks }); 
                        hasPendingTasks = tasks.some((t: any) => !['done', 'completed'].includes((t.status || '').toLowerCase()));
                    } catch {} 
                }

                // Check for response truncation (unclosed XML tags)
                const openEdit = /<edit\b/.test(buf) && !buf.includes('</edit>');
                const openCreate = /<create\b/.test(buf) && !buf.includes('</create>');
                const openThink = /<think\b/.test(buf) && !buf.includes('</think>');
                const openAskUser = /<ask_user\b/.test(buf) && !buf.includes('</ask_user>');
                const truncated = openEdit || openCreate || openThink || openAskUser;

                if (truncated) {
                    this.d.post({ command: 'agentStatus', text: 'Resuming truncated response…' });
                    work.push({ role: 'user', content: '[SYSTEM NOTE: Your last response was truncated before closing XML tags. Please continue outputting the rest of the content and close the tags now.]' });
                    continue;
                }

                if (finishReason === 'MAX_TOKENS') {
                    this.d.post({ command: 'agentStatus', text: 'Resuming from token limit…' });
                    work.push({ role: 'user', content: '[SYSTEM NOTE: Your last response hit the output token limit. Please continue exactly where you left off, and remember to close any XML tags if they were cut off.]' });
                    continue;
                }

                const calls = this.parseTools(buf);

                // Prose outside of tags = the model's narration / final answer.
                const prose = stripTags(buf).trim();
                if (prose) { this.d.post({ command: 'agentProse', text: prose }); finalProse = prose; }

                if (!calls.length) { 
                    if (hasPendingTasks) {
                        work.push({ role: 'user', content: 'You have unfinished tasks in your task list. Please proceed with execution by emitting the necessary tool tags. Do NOT stop.' });
                        continue;
                    }
                    if (tl) {
                        work.push({ role: 'user', content: 'Task list received. Please proceed with execution by emitting tool tags.' });
                        continue;
                    }
                    break; // final answer
                }

                // Execute: run all tool calls in the response.
                const results: string[] = [];
                const subagentPromises: Promise<string>[] = [];
                let spawnedAgentThisTurn = false;
                for (const c of calls) {
                    if (this._cancelled) break;

                    if (c.tool === 'spawn_agent') {
                        subagentPromises.push(this.doSpawn(c));
                        spawnedAgentThisTurn = true;
                        continue;
                    }

                    if (spawnedAgentThisTurn) {
                        results.push(`[SYSTEM NOTE: <${c.tool}> was IGNORED. You spawned an agent prior to this command. You must wait for the subagent to finish before issuing further commands.]`);
                        continue;
                    }

                    if (c.tool === 'edit' || c.tool === 'create') {
                        results.push(await this.doWrite(c));
                    } else if (c.tool === 'ask_user') {
                        results.push(await this.doAsk(c));
                        break; // ask_user stops execution to wait for user input
                    } else if (c.tool === 'run_command') {
                        results.push(await this.doCommand(c));
                    
                    } else if (['overwrite_file', 'append_file'].includes(c.tool)) {
                        results.push(await this.doAdvancedWrite(c));
                    } else if (['fetch_url','search_web','delete_file','rename_file','read_dir','git_status','git_diff','git_commit','git_log','git_blame','create_branch','run_tests','search_regex','npm_install','curl_request','read_json','copy_file','get_file_info','create_dir','format_json','get_env_var','base64_encode','base64_decode','zip_dir','unzip_file'].includes(c.tool)) {
                        results.push(await this.doAdvancedRead(c));
                    } else if (c.tool === 'run_code') {
                        results.push(await this.doRunCode(c));
                    } else {
                        results.push(await this.doRead(c));
                    }
                }
                if (subagentPromises.length) {
                    const subResults = await Promise.all(subagentPromises);
                    results.push(...subResults);
                }
                work.push({ role: 'user', content: '[tool results]\n' + results.join('\n\n') });
            }
        } catch (e: any) {
            this.d.post({ command: 'agentError', message: e.message });
            return finalProse;
        }
        this.d.post({ command: 'agentDone' });
        return finalProse;
    }

    private parseTools(buf: string): ToolCall[] {
        const calls: ToolCall[] = [];
        const push = (tool: string, attrStr: string, body: string, raw: string) => {
            const attrs: Record<string, string> = {};
            for (const a of matchAllPairs(attrStr, /(\w+)\s*=\s*"([^"]*)"/g)) attrs[a[0]] = a[1];
            calls.push({ tool, attrs, body, raw });
        };
        // CRITICAL: Strip out thought blocks so we don't accidentally execute tools hallucinated inside them
        const activeBuf = buf.replace(/<think\b[^>]*>[\s\S]*?<\/think>/g, '').replace(/<thought\b[^>]*>[\s\S]*?<\/thought>/g, '');
        for (const m of matchAllFull(activeBuf, /<(read_file|list_files|search_files)\b([^>]*?)\/?>/g)) push(m[1], m[2] || '', '', m[0]);
        for (const m of matchAllFull(activeBuf, /<edit\b([^>]*?)>([\s\S]*?)<\/edit>/g)) push('edit', m[1] || '', m[2] || '', m[0]);
        for (const m of matchAllFull(activeBuf, /<create\b([^>]*?)>([\s\S]*?)<\/create>/g)) push('create', m[1] || '', m[2] || '', m[0]);
        for (const m of matchAllFull(activeBuf, /<ask_user>([\s\S]*?)<\/ask_user>/g)) push('ask_user', '', m[1] || '', m[0]);
        for (const m of matchAllFull(activeBuf, /<spawn_agent\b([^>]*?)\/?>/g)) push('spawn_agent', m[1] || '', '', m[0]);
        for (const m of matchAllFull(activeBuf, /<run_command\b([^>]*?)\/?>/g)) push('run_command', m[1] || '', '', m[0]);
        for (const m of matchAllFull(activeBuf, /<run_code\b([^>]*?)>([\s\S]*?)<\/run_code>/g)) push('run_code', m[1] || '', m[2] || '', m[0]);

        const toolsNoBody = ['fetch_url','search_web','delete_file','rename_file','read_dir','git_status','git_diff','git_commit','git_log','git_blame','create_branch','run_tests','search_regex','npm_install','curl_request','read_json','copy_file','get_file_info','create_dir','format_json','get_env_var','base64_encode','base64_decode','zip_dir','unzip_file'];
        for (const t of toolsNoBody) {
            for (const m of matchAllFull(activeBuf, new RegExp(`<${t}\\b([^>]*?)\/?>`, 'g'))) push(t, m[1] || '', '', m[0]);
        }
        for (const m of matchAllFull(activeBuf, /<overwrite_file\b([^>]*?)>([\s\S]*?)<\/overwrite_file>/g)) push('overwrite_file', m[1] || '', m[2] || '', m[0]);
        for (const m of matchAllFull(activeBuf, /<append_file\b([^>]*?)>([\s\S]*?)<\/append_file>/g)) push('append_file', m[1] || '', m[2] || '', m[0]);

        // Keep document order so a write/ask appearing before reads is handled correctly.
        calls.sort((a, b) => buf.indexOf(a.raw) - buf.indexOf(b.raw));
        
        if (this.allowedTools && this.allowedTools.length > 0) {
            const alwaysAllowed = ['ask_user', 'spawn_agent'];
            return calls.filter(c => this.allowedTools!.includes(c.tool) || alwaysAllowed.includes(c.tool));
        }
        
        return calls;
    }

    private async doRead(c: ToolCall): Promise<string> {
        const ws = this.d.workspaceUri();
        this.d.post({ command: 'agentToolCall', id: c.raw.length + '', tool: c.tool, detail: c.attrs.path || c.attrs.pattern || '' });
        try {
            if (c.tool === 'list_files') {
                const tree = await getProjectTree();
                this.d.post({ command: 'agentToolResult', tool: c.tool, success: true, output: 'project tree' });
                return '[list_files]\n' + tree;
            }
            if (c.tool === 'search_files') {
                const files = await getAllFiles();
                const rx = safeRegex(c.attrs.pattern || '');
                const hits: string[] = [];
                for (const rel of files) {
                    if (c.attrs.glob && !globMatch(c.attrs.glob, rel)) continue;
                    if (!ws) break;
                    try {
                        const txt = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(ws, rel))).toString('utf-8');
                        txt.split('\n').forEach((line, i) => { if (rx.test(line) && hits.length < 50) hits.push(rel + ':' + (i + 1) + ': ' + line.trim().slice(0, 160)); });
                    } catch {}
                    if (hits.length >= 50) break;
                }
                this.d.post({ command: 'agentToolResult', tool: c.tool, success: true, output: hits.length + ' matches' });
                return '[search_files ' + c.attrs.pattern + ']\n' + (hits.join('\n') || '(no matches)');
            }
            // read_file
            if (!ws) return '[read_file] no workspace';
            const data = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(ws, c.attrs.path))).toString('utf-8');
            const clipped = clip(data, 6000);
            this.d.post({ command: 'agentToolResult', tool: c.tool, success: true, output: data.length + ' bytes' });
            return '[read_file ' + c.attrs.path + ']\n' + clipped;
        } catch (e: any) {
            this.d.post({ command: 'agentToolResult', tool: c.tool, success: false, output: e.message });
            return '[' + c.tool + ' ' + (c.attrs.path || '') + '] ERROR: ' + e.message;
        }
    }

    private async doWrite(c: ToolCall): Promise<string> {
        const ws = this.d.workspaceUri();
        const fp = c.attrs.path;
        if (!ws || !fp) return '[' + c.tool + '] missing workspace or path';
        
        const mode = this.d.getMode();
        if (mode === 'plan' && !fp.includes('.flash/plan.md') && !fp.endsWith('.md') && !fp.includes('.agent_work/')) {
            return `[${c.tool} ${fp}] ERROR: Code edits are STRICTLY FORBIDDEN in 'plan' mode. You may only create or edit .md documentation files.`;
        }
        
        const uri = vscode.Uri.joinPath(ws, fp);
        let old = '';
        try { old = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf-8'); } catch {}

        // Build the new content: create = full body; edit = SEARCH/REPLACE pairs.
        let newContent: string, failures: string[] = [];
        if (c.tool === 'create') {
            newContent = c.body.replace(/\n$/, '');
        } else {
            const pairs: { search: string; replace: string }[] = [];
            const SR = /<<<<<<<\s*SEARCH\s*\n([\s\S]*?)\n?=======\s*\n([\s\S]*?)\n?>>>>>>>\s*REPLACE/g;
            let s: RegExpExecArray | null; while ((s = SR.exec(c.body)) !== null) pairs.push({ search: s[1], replace: s[2] });
            const r = applyEdits(old, { path: fp, pairs });
            newContent = r.content; failures = r.failures;
        }

        if (failures.length && newContent === old) {
            // self-correction: tell the model what failed + show the current file
            return '[edit ' + fp + '] SEARCH text not found (' + failures.join('; ') + ').\nCurrent file content:\n' + clip(old, 6000) + '\nRe-read and retry with EXACT text.';
        }

        // The diff card (with its "Edit <path> [badge]" header) is the only UI for a write — no separate tool card.
        const diff = computeSideBySide(old, newContent);
        if (mode === 'ask') {
            const diffId = Math.random().toString(36).substring(7);
            this.d.post({ command: 'showDiff', diffId, changes: [{ path: fp, diff, badge: old ? 'Modified' : 'new' }] });
            const accepted = await new Promise<boolean>(res => { this.d.registerDiffResolver(diffId, res); });
            if (!accepted) return '[' + c.tool + ' ' + fp + '] User REJECTED the change.';
            this.d.recordSnapshot(fp, old);
            await vscode.workspace.fs.writeFile(uri, Buffer.from(newContent, 'utf-8'));
            return '[' + c.tool + ' ' + fp + '] accepted; written.';
        }
        // plan (for .md files), auto-edit, or autonomous
        this.d.recordSnapshot(fp, old);
        await vscode.workspace.fs.writeFile(uri, Buffer.from(newContent, 'utf-8'));
        this.d.post({ command: 'showDiff', changes: [{ path: fp, diff, badge: old ? 'Modified' : 'new', applied: true }] });
        return '[' + c.tool + ' ' + fp + '] written.';
    }

    private async doAsk(c: ToolCall): Promise<string> {
        let payload: any = {};
        try { payload = JSON.parse(c.body.trim()); } catch { payload = { questions: [{ header: 'Question', question: c.body.trim(), options: [] }] }; }
        this.d.post({ command: 'agentAskUser', questions: payload.questions || [] });
        const answer = await new Promise<string>(res => { this._userInput = res; });
        return '[ask_user] User answered: ' + answer;
    }

    private async doSpawn(c: ToolCall): Promise<string> {
        const role = c.attrs.role || 'Background Worker';
        const task = c.attrs.task || 'Analyzing workspace';
        const id = Math.random().toString(36).substring(7);

        this.d.post({ command: 'agentSpawn', id, role, task });
        this.d.post({ command: 'agentProgress', id, percentage: 10, log: `Initializing parallel agent [${role}]...` });

        const dispatcher = TaskDispatcher.getInstance();
        dispatcher.registerAgent(id, role, task);
        // Do NOT create a worktree for child agents; they inherit the parent's worktree!

        try {
            const profile = getProfileByRole(role);
            const rules = RulesEngine.getInstance().getProjectRules();
            const sysPrompt = profile.systemPrompt + '\n\n' + WEB_DESIGN_DIRECTIVES + (rules ? `\n\n${rules}` : '') + `\n\nYour specific task is: "${task}".`;

            const subagent = new AgentRunner({
                post: (msg) => {
                    if (msg.command === 'agentStatus') {
                        dispatcher.updateAgent(id, 'Executing', msg.text);
                        this.d.post({ command: 'agentProgress', id, log: `[Status] ${msg.text}` });
                    } else if (msg.command === 'agentThinking') {
                        this.d.post({ command: 'agentProgress', id, log: `[Thinking] ${msg.text}` });
                    } else if (msg.command === 'agentToolCall') {
                        this.d.post({ command: 'agentProgress', id, log: `[Tool Call] <${msg.tool} detail="${msg.detail}">` });
                    } else if (msg.command === 'agentToolOutput') {
                        this.d.post({ command: 'agentProgress', id, log: msg.text });
                    } else if (msg.command === 'agentToolResult') {
                        this.d.post({ command: 'agentProgress', id, log: `[Tool Result] ${msg.success ? 'Success' : 'Failed'}: ${msg.output}` });
                    } else if (msg.command === 'agentTaskList') {
                        dispatcher.updateAgent(id, 'Planning', 'Created plan');
                        this.d.post({ command: 'agentProgress', id, log: `[Plan] ${JSON.stringify(msg.tasks)}` });
                    } else if (msg.command === 'agentProse') {
                        this.d.post({ command: 'agentProgress', id, log: msg.text });
                    } else if (msg.command === 'agentError') {
                        dispatcher.updateAgent(id, 'Error', msg.message);
                        this.d.post({ command: 'agentProgress', id, log: `[Error] ${msg.message}` });
                    } else if (msg.command === 'showDiff') {
                        this.d.post(msg);
                    } else {
                        this.d.post(msg);
                    }
                },
                send: (messages, onChunk) => this.d.send(messages, (chunk) => {
                    onChunk(chunk);
                    this.d.post({ command: 'agentProgress', id, log: chunk });
                }),
                workspaceUri: () => this.d.workspaceUri(),
                getMode: () => this.d.getMode(),
                recordSnapshot: (path, old) => this.d.recordSnapshot(path, old),
                askCommand: (cmd) => this.d.askCommand(cmd),
                registerDiffResolver: (diffId, resolve) => this.d.registerDiffResolver(diffId, resolve),
                askCode: (lang, code) => this.d.askCode(lang, code)
            }, sysPrompt);

            this.d.post({ command: 'agentProgress', id, percentage: 30, log: 'Starting execution...' });
            
            const subHistory: Msg[] = [
                { role: 'system', content: sysPrompt }
            ];

            const finalText = await subagent.run(`Start execution of task: "${task}"`, subHistory);

            dispatcher.updateAgent(id, 'Completed', 'Subtask completed successfully.');
            this.d.post({ command: 'agentProgress', id, percentage: 100, log: 'Worker execution complete.' });
            this.d.post({ command: 'agentFinish', id, success: true, log: '\n--- Worker Finished ---' });
            return `[Subagent ${role}] completed task: ${task}. Result:\n${finalText}`;
        } catch (e: any) {
            dispatcher.updateAgent(id, 'Error', `Failed: ${e.message}`);
            this.d.post({ command: 'agentFinish', id, success: false, log: `\nError encountered: ${e.message}` });
            return `[Subagent ${role}] failed task: ${task}. Error: ${e.message}`;
        }
    }

    private async doCommand(c: ToolCall, bypassAsk = false): Promise<string> {
        const cmd = c.attrs.command || c.attrs.cmd;
        if (!cmd) return '[run_command] Error: no command specified.';

        const mode = this.d.getMode();
        if ((mode === 'ask' || mode === 'plan') && !bypassAsk) {
            // Request user approval via the permission dialog workflow
            const approved = await this.d.askCommand(cmd);
            if (!approved) {
                return `[run_command] User REJECTED execution of command: "${cmd}".`;
            }
        }

        const ws = this.d.workspaceUri();
        const cwd = ws ? ws.fsPath : process.cwd();

        this.d.post({ command: 'agentToolCall', id: c.raw.length + '', tool: c.tool, detail: cmd });

        return new Promise<string>((resolve) => {
            const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';
            const shellArgs = process.platform === 'win32' 
                ? ['-NoProfile', '-NonInteractive', '-Command', cmd] 
                : ['-c', cmd];

            const child = spawn(shell, shellArgs, {
                cwd,
                env: { ...process.env, FORCE_COLOR: '1' },
                shell: false,
            });

            let outBuffer = '';

            child.stdout?.on('data', (data: Buffer) => {
                const chunk = stripVTControlCharacters(data.toString('utf-8'));
                outBuffer += chunk;
                this.d.post({ command: 'agentToolOutput', tool: c.tool, text: chunk });
            });

            child.stderr?.on('data', (data: Buffer) => {
                const chunk = stripVTControlCharacters(data.toString('utf-8'));
                outBuffer += chunk;
                this.d.post({ command: 'agentToolOutput', tool: c.tool, text: chunk });
            });

            child.on('close', (code) => {
                const success = code === 0;
                this.d.post({
                    command: 'agentToolResult',
                    tool: c.tool,
                    success,
                    output: `Exit code: ${code}\n\n` + clip(outBuffer, 1200)
                });
                resolve(`[run_command "${cmd}"] finished with exit code ${code}. Output:\n` + clip(outBuffer, 3000));
            });

            child.on('error', (err) => {
                this.d.post({ command: 'agentToolResult', tool: c.tool, success: false, output: err.message });
                resolve(`[run_command "${cmd}"] failed to spawn: ${err.message}`);
            });
        });
    }

    private async doRunCode(c: ToolCall): Promise<string> {
        const ws = this.d.workspaceUri();
        if (!ws) return '[run_code] Error: no workspace open.';
        const lang = (c.attrs.lang || 'sh').toLowerCase();

        let ext = 'sh';
        let execCmd = '';
        if (lang === 'js' || lang === 'javascript') {
            ext = 'js';
            execCmd = 'node';
        } else if (lang === 'py' || lang === 'python') {
            ext = 'py';
            execCmd = 'python';
        } else {
            if (process.platform === 'win32') {
                ext = 'ps1';
                execCmd = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File';
            } else {
                ext = 'sh';
                execCmd = 'bash';
            }
        }

        const scratchDirUri = vscode.Uri.joinPath(ws, '.flashcode_scratch');
        try {
            await vscode.workspace.fs.createDirectory(scratchDirUri);
        } catch {}

        const uuid = Math.random().toString(36).substring(2, 10);
        const fileName = `scratch_${uuid}.${ext}`;
        const fileUri = vscode.Uri.joinPath(scratchDirUri, fileName);

        try {
            await vscode.workspace.fs.writeFile(fileUri, Buffer.from(c.body, 'utf-8'));
        } catch (e: any) {
            return `[run_code] Error creating scratch file: ${e.message}`;
        }

        const mode = this.d.getMode();
        if (mode === 'ask' || mode === 'plan') {
            const approved = await this.d.askCode(lang, c.body);
            if (!approved) {
                try {
                    await vscode.workspace.fs.delete(fileUri);
                } catch {}
                return `[run_code] User REJECTED execution of script.`;
            }
        }

        const fullCommand = `${execCmd} "${fileUri.fsPath}"`;
        try {
            const result = await this.doCommand({
                tool: 'run_code',
                attrs: { cmd: fullCommand },
                body: '',
                raw: c.raw
            }, true);
            return result;
        } finally {
            try {
                await vscode.workspace.fs.delete(fileUri);
            } catch {}
        }
    }

    private async doAdvancedWrite(c: ToolCall): Promise<string> {
        const ws = this.d.workspaceUri();
        const fp = c.attrs.path;
        if (!ws || !fp) return '[' + c.tool + '] missing workspace or path';
        
        const mode = this.d.getMode();
        if (mode === 'plan' && !fp.includes('.flash/plan.md') && !fp.endsWith('.md') && !fp.includes('.agent_work/')) {
            return `[${c.tool} ${fp}] ERROR: Code edits are STRICTLY FORBIDDEN in 'plan' mode. You may only create or edit .md documentation files.`;
        }
        
        if (mode === 'ask') {
            const approved = await this.d.askCommand(`Allow ${c.tool} to modify ${fp}?`);
            if (!approved) return '[' + c.tool + ' ' + fp + '] User REJECTED the file modification.';
        }

        const uri = vscode.Uri.joinPath(ws, fp);
        try {
            if (c.tool === 'overwrite_file') {
                await vscode.workspace.fs.writeFile(uri, Buffer.from(c.body, 'utf-8'));
                return '[' + c.tool + ' ' + fp + '] file overwritten successfully.';
            } else if (c.tool === 'append_file') {
                let old = '';
                try { old = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf-8'); } catch {}
                const newContent = old + (old.endsWith('\n') ? '' : '\n') + c.body;
                await vscode.workspace.fs.writeFile(uri, Buffer.from(newContent, 'utf-8'));
                return '[' + c.tool + ' ' + fp + '] content appended successfully.';
            }
        } catch (e: any) {
            return '[' + c.tool + ' ' + fp + '] ERROR: ' + e.message;
        }
        return '';
    }

    private async doAdvancedRead(c: ToolCall): Promise<string> {
        this.d.post({ command: 'agentToolCall', id: c.raw.length + '', tool: c.tool, detail: JSON.stringify(c.attrs) });
        
        const cmdMap: Record<string, string> = {
            'git_status': 'git status --short',
            'git_diff': 'git diff ' + (c.attrs.path || ''),
            'git_commit': 'git add . && git commit -m "' + (c.attrs.message || 'auto commit') + '"',
            'git_log': 'git log -n ' + (c.attrs.n || '5') + ' --oneline',
            'git_blame': 'git blame -L ' + (c.attrs.line || '1') + ',' + (c.attrs.line || '1') + ' ' + (c.attrs.path || ''),
            'create_branch': 'git checkout -b ' + (c.attrs.name || 'new-branch'),
            'npm_install': 'npm install ' + (c.attrs.packages || ''),
            'run_tests': c.attrs.command || 'npm run test',
            'search_regex': 'findstr /s /c:"' + (c.attrs.pattern || '') + '" *.*',
            'zip_dir': process.platform === 'win32' ? `powershell Compress-Archive -Path "${c.attrs.src}\\*" -DestinationPath "${c.attrs.dest}"` : `zip -r "${c.attrs.dest}" "${c.attrs.src}"`,
            'unzip_file': process.platform === 'win32' ? `powershell Expand-Archive -Path "${c.attrs.src}" -DestinationPath "${c.attrs.dest}"` : `unzip "${c.attrs.src}" -d "${c.attrs.dest}"`
        };

        if (cmdMap[c.tool]) {
            return new Promise(resolve => {
                const child = require('child_process').exec(cmdMap[c.tool], { cwd: this.d.workspaceUri()?.fsPath });
                let out = '';
                child.stdout?.on('data', (d: any) => out += d);
                child.stderr?.on('data', (d: any) => out += d);
                child.on('close', () => {
                    this.d.post({ command: 'agentToolResult', tool: c.tool, success: true, output: out.length + ' bytes' });
                    resolve('[' + c.tool + ']\n' + (out.slice(0, 4000) || '(no output)'));
                });
            });
        }

        try {
            const ws = this.d.workspaceUri();
            
            if (c.tool === 'fetch_url') {
                if (!c.attrs.url) return '[fetch_url] Error: url required.';
                const res = await fetch(c.attrs.url);
                return '[fetch_url]\n' + clip(await res.text(), 6000);
            }
            if (c.tool === 'curl_request') {
                const method = c.attrs.method || 'GET';
                let headers = {};
                try { if (c.attrs.headers) headers = JSON.parse(c.attrs.headers); } catch {}
                const res = await fetch(c.attrs.url, { method, headers, body: c.attrs.body || undefined });
                return '[curl_request]\n' + clip(await res.text(), 6000);
            }
            if (c.tool === 'search_web') {
                const query = c.attrs.query;
                if (!query) {
                    return '[search_web] Error: query attribute is missing.';
                }
                try {
                    const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
                    const res = await fetch(url, {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                        }
                    });
                    if (!res.ok) {
                        return `[search_web] HTTP error! Status: ${res.status}`;
                    }
                    const html = await res.text();
                    const blocks = html.split('result__body');
                    const results: { title: string; url: string; snippet: string }[] = [];
                    
                    for (let i = 1; i < blocks.length; i++) {
                        const block = blocks[i];
                        
                        const titleMatch = block.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/);
                        let title = titleMatch ? titleMatch[1] : '';
                        title = title.replace(/<[^>]+>/g, '').trim();
                        
                        const urlMatch = block.match(/href="([^"]+)"/);
                        let url = urlMatch ? urlMatch[1] : '';
                        if (url.startsWith('//')) {
                            url = 'https:' + url;
                        }
                        if (url.includes('uddg=')) {
                            const match = url.match(/uddg=([^&]+)/);
                            if (match) {
                                url = decodeURIComponent(match[1]);
                            }
                        }
                        
                        const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
                        let snippet = snippetMatch ? snippetMatch[1] : '';
                        snippet = snippet.replace(/<[^>]+>/g, '').trim();
                        
                        // Decode common HTML entities
                        const decodeEntities = (str: string) => {
                            return str
                                .replace(/&amp;/g, '&')
                                .replace(/&lt;/g, '<')
                                .replace(/&gt;/g, '>')
                                .replace(/&quot;/g, '"')
                                .replace(/&#x27;/g, "'")
                                .replace(/&#39;/g, "'")
                                .replace(/&apos;/g, "'")
                                .replace(/&#92;/g, '\\');
                        };
                        
                        title = decodeEntities(title);
                        snippet = decodeEntities(snippet);
                        
                        if (title || snippet) {
                            results.push({ title, url, snippet });
                        }
                    }
                    
                    if (results.length === 0) {
                        return `[search_web] No results found for query: "${query}"`;
                    }
                    
                    let output = `[search_web results for "${query}"]\n\n`;
                    for (let j = 0; j < Math.min(results.length, 8); j++) {
                        const r = results[j];
                        output += `${j + 1}. Title: ${r.title}\n   URL: ${r.url}\n   Snippet: ${r.snippet}\n\n`;
                    }
                    return output;
                } catch (e: any) {
                    return `[search_web] Error during search: ${e.message}`;
                }
            }
            if (c.tool === 'base64_encode') {
                return '[base64_encode]\n' + Buffer.from(c.attrs.text || '').toString('base64');
            }
            if (c.tool === 'base64_decode') {
                return '[base64_decode]\n' + Buffer.from(c.attrs.text || '', 'base64').toString('utf-8');
            }
            if (c.tool === 'get_env_var') {
                return '[get_env_var]\n' + (process.env[c.attrs.name || ''] || '(not set)');
            }

            // FS tools require workspace
            if (!ws) return '[' + c.tool + '] error: no workspace';
            const vfs = vscode.workspace.fs;

            if (c.tool === 'delete_file') {
                await vfs.delete(vscode.Uri.joinPath(ws, c.attrs.path || ''));
                return '[delete_file] success.';
            }
            if (c.tool === 'rename_file') {
                await vfs.rename(vscode.Uri.joinPath(ws, c.attrs.src || ''), vscode.Uri.joinPath(ws, c.attrs.dest || ''));
                return '[rename_file] success.';
            }
            if (c.tool === 'read_dir') {
                const entries = await vfs.readDirectory(vscode.Uri.joinPath(ws, c.attrs.path || ''));
                return '[read_dir]\n' + entries.map(e => e[0] + (e[1] === 2 ? '/' : '')).join('\n');
            }
            if (c.tool === 'create_dir') {
                await vfs.createDirectory(vscode.Uri.joinPath(ws, c.attrs.path || ''));
                return '[create_dir] success.';
            }
            if (c.tool === 'copy_file') {
                await vfs.copy(vscode.Uri.joinPath(ws, c.attrs.src || ''), vscode.Uri.joinPath(ws, c.attrs.dest || ''));
                return '[copy_file] success.';
            }
            if (c.tool === 'get_file_info') {
                const stat = await vfs.stat(vscode.Uri.joinPath(ws, c.attrs.path || ''));
                return `[get_file_info]\nSize: ${stat.size} bytes\nModified: ${new Date(stat.mtime).toISOString()}`;
            }
            if (c.tool === 'read_json') {
                const data = Buffer.from(await vfs.readFile(vscode.Uri.joinPath(ws, c.attrs.path || ''))).toString('utf-8');
                const obj = JSON.parse(data);
                const key = c.attrs.key;
                return '[read_json]\n' + JSON.stringify(key ? obj[key] : obj, null, 2);
            }
            if (c.tool === 'format_json') {
                const uri = vscode.Uri.joinPath(ws, c.attrs.path || '');
                const data = Buffer.from(await vfs.readFile(uri)).toString('utf-8');
                const formatted = JSON.stringify(JSON.parse(data), null, 2);
                await vfs.writeFile(uri, Buffer.from(formatted, 'utf-8'));
                return '[format_json] success.';
            }

            return '[' + c.tool + '] executed successfully.';
        } catch (e: any) {
            return '[' + c.tool + '] ERROR: ' + e.message;
        }
    }
}

// ---- helpers ----
function matchAll(s: string, rx: RegExp): string[] { const out: string[] = []; let m; while ((m = rx.exec(s)) !== null) out.push(m[1]); return out; }
function matchAllFull(s: string, rx: RegExp): RegExpExecArray[] { const out: RegExpExecArray[] = []; let m; while ((m = rx.exec(s)) !== null) out.push(m); return out; }
function matchAllPairs(s: string, rx: RegExp): [string, string][] { const out: [string, string][] = []; let m; while ((m = rx.exec(s)) !== null) out.push([m[1], m[2]]); return out; }
function stripTags(s: string): string {
    return s
        .replace(/<think\b[^>]*>[\s\S]*?<\/think>/g, '')
        .replace(/<thought\b[^>]*>[\s\S]*?<\/thought>/g, '')
        .replace(/<status>[\s\S]*?<\/status>/g, '')
        .replace(/<task_list>[\s\S]*?<\/task_list>/g, '')
        .replace(/<edit\b[^>]*?>[\s\S]*?<\/edit>/g, '')
        .replace(/<create\b[^>]*?>[\s\S]*?<\/create>/g, '')
        .replace(/<ask_user>[\s\S]*?<\/ask_user>/g, '')
        .replace(/<spawn_agent\b[^>]*?\/?>/g, '')
        .replace(/<run_command\b[^>]*?>([\s\S]*?<\/run_command>)?/g, '')
        .replace(/<run_code\b[^>]*?>[\s\S]*?<\/run_code>/g, '')
        .replace(/<(read_file|list_files|search_files)\b[^>]*?\/?>/g, '');
}
function clip(s: string, max: number): string {
    if (s.length <= max) return s;
    return s.slice(0, Math.floor(max * 0.7)) + '\n…(truncated)…\n' + s.slice(-Math.floor(max * 0.3));
}
function safeRegex(p: string): RegExp { try { return new RegExp(p, 'i'); } catch { return new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); } }
function globMatch(glob: string, rel: string): boolean {
    const rx = new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '§').replace(/\*/g, '[^/]*').replace(/§/g, '.*') + '$');
    return rx.test(rel);
}