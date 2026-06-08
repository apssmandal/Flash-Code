import * as vscode from 'vscode';
import { Msg } from './backends/types';
import { getProjectTree, getAllFiles } from './fileManager';
import { computeSideBySide } from './diffUtils';
import { applyEdits } from './editUtils';
import { getProfileByRole } from './subagents/registry';
import { spawn } from 'child_process';
import { stripVTControlCharacters } from 'util';

export const AGENT_PROMPT =
`You are "Flash Code", a state-of-the-art autonomous coding agent executing directly inside a VS Code workspace.
You solve tasks systematically by planning, invoking workspace tools, observing results, self-correcting, and cooperating with background agents.

=========================================
OUTPUT FORMAT & XML TOOL TAGS
=========================================
Your output can contain text (prose) and tool execution tags. All tool tags MUST be raw, unescaped XML (NEVER wrap tool tags in markdown code blocks like \`\`\`xml ... \`\`\`).
You can emit the following tags:

  <think>your private step-by-step reasoning</think>
  <status>a short, single-line progress note in the present tense (e.g., "Compiling source files...")</status>
  
  <task_list>[{"id":"1","desc":"task description","status":"pending"}]</task_list>
     (Emitted on the FIRST turn only to outline your checklist. Statuses: "pending" | "running" | "done" | "failed")
     
  <read_file path="relative/path"/>
     (Inspect the content of a file. Path must be relative to the workspace root.)
     
  <list_files/>
     (Prints the workspace directory file tree.)
     
  <search_files pattern="regex_or_string" glob="**/*.ts"/>
     (Grep-search files in the workspace matching the regex pattern and optional glob filter.)
     
  <create path="relative/path">COMPLETE new file content</create>
     (Create a new file with its full boilerplate, imports, and content.)
     
  <edit path="relative/path">
  <<<<<<< SEARCH
  exact existing lines, copied verbatim
  =======
  the new lines to replace them
  >>>>>>> REPLACE
  </edit>
     (Apply targeted changes to an existing file using SEARCH/REPLACE blocks. SEARCH block must match verbatim, including whitespace and indentation.)

  <run_command cmd="shell command to run"/>
     (Execute a terminal command in the workspace. All commands must be NON-INTERACTIVE. Use auto-approve flags like -y, --yes, --force, or -m "msg" since no terminal input stream exists.)

  <run_code lang="js|py|sh">your custom script code</run_code>
     (Write a custom script dynamically in Node.js (js), Python (py), or Shell/Powershell (sh) to perform checks, computation, or search routines, and execute it within the workspace shell. The code must be enclosed directly inside the tag.)

  <spawn_agent role="Researcher|Tester|Linter|Refactorer" task="subtask description"/>
     (Spawn a background subagent to work in parallel on specialized subtasks. They run concurrently and report findings back.)

  <ask_user>{"questions":[{"header":"Header","question":"Question text","options":[{"label":"A","description":"desc"}],"multiSelect":false}]}</ask_user>
     (Present choices/forms to the user. MultiSelect false renders radio buttons; true renders checkboxes.)

=========================================
CRITICAL OPERATIONAL RULES
=========================================
1. PLANNING: Always emit a <task_list> first, then begin execution. Keep your status messages clear.
2. BATCHING READS: If you need to inspect multiple files, emit ALL <read_file> tags in a single turn. Do not retrieve them sequentially over multiple turns.
3. BATCHING WRITES: Emit multiple <edit> and/or <create> tags in a single turn to apply all logical code modifications together.
4. EXACT SEARCH/REPLACE: The SEARCH block in <edit> tags MUST match the existing code precisely. If a write fails, read the file again to obtain the exact text. Never guess or omit code structure.
5. NON-INTERACTIVE COMMANDS: When using <run_command>, ensure the command does not prompt for input. Avoid interactive interactive prompts (e.g., do NOT run "npm init" without "-y").
6. USER CONFIRMATION: For crucial decisions (frameworks, tech stack, naming, layouts, styling, libraries), stop and ask the user using <ask_user> with concrete options.
7. PARALLEL DELEGATION: Outsource testing, linting, code auditing, or multi-file research to specialized subagents. Summarize their results in your final prose.
8. CONCLUSION: When the task is complete, return a concise plain-text summary of your changes. Do NOT emit any tool tags in your final completion turn.`;

interface ToolCall { tool: string; attrs: Record<string, string>; body: string; raw: string; }

export interface AgentDeps {
    post: (m: any) => void;
    send: (messages: Msg[], onChunk: (t: string) => void) => Promise<{ text: string; backend: string }>;
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

    constructor(private d: AgentDeps, private systemPrompt: string = AGENT_PROMPT) {}

    cancel() { this._cancelled = true; this._userInput?.('[cancelled]'); }
    resolveUserInput(v: string) { this._userInput?.(v); this._userInput = undefined; }

    async run(userText: string, history: Msg[]): Promise<string> {
        this._cancelled = false;
        const tree = await getProjectTree();
        const sys = this.systemPrompt + '\n\nProject structure:\n' + tree;
        const work: Msg[] = [...history.slice(-8), { role: 'user', content: userText }];
        let finalProse = '';

        try {
            for (let iter = 0; iter < 50; iter++) {
                if (this._cancelled) { this.d.post({ command: 'agentStatus', text: 'Stopped.' }); break; }

                const messages: Msg[] = [{ role: 'system', content: sys }, ...work];
                this.d.post({ command: 'agentStatus', text: 'Thinking…' });
                const { text: buf } = await this.d.send(messages, () => { /* tokens buffered; cards render per-turn */ });
                work.push({ role: 'assistant', content: buf });

                // Render think / status / task_list segments.
                for (const t of matchAll(buf, /<think\b[^>]*>([\s\S]*?)<\/think>/g)) this.d.post({ command: 'agentThinking', text: t.trim() });
                for (const s of matchAll(buf, /<status>([\s\S]*?)<\/status>/g)) this.d.post({ command: 'agentStatus', text: s.trim() });
                const tl = /<task_list>([\s\S]*?)<\/task_list>/.exec(buf);
                if (tl) { try { this.d.post({ command: 'agentTaskList', tasks: JSON.parse(tl[1].trim()) }); } catch {} }

                // Check for response truncation (unclosed XML tags)
                const openEdit = buf.includes('<edit') && !buf.includes('</edit>');
                const openCreate = buf.includes('<create') && !buf.includes('</create>');
                const openThink = buf.includes('<think') && !buf.includes('</think>');
                const openAskUser = buf.includes('<ask_user') && !buf.includes('</ask_user>');
                const truncated = openEdit || openCreate || openThink || openAskUser;

                if (truncated) {
                    this.d.post({ command: 'agentStatus', text: 'Resuming truncated response…' });
                    work.push({ role: 'user', content: '[SYSTEM NOTE: Your last response was truncated before closing XML tags. Please continue outputting the rest of the content and close the tags now.]' });
                    continue;
                }

                const calls = this.parseTools(buf);

                // Prose outside of tags = the model's narration / final answer.
                const prose = stripTags(buf).trim();
                if (prose) { this.d.post({ command: 'agentProse', text: prose }); finalProse = prose; }

                if (!calls.length) { break; } // final answer

                // Execute: run all tool calls in the response.
                const results: string[] = [];
                const subagentPromises: Promise<string>[] = [];
                for (const c of calls) {
                    if (this._cancelled) break;
                    if (c.tool === 'edit' || c.tool === 'create') {
                        results.push(await this.doWrite(c));
                    } else if (c.tool === 'ask_user') {
                        results.push(await this.doAsk(c));
                        break; // ask_user stops execution to wait for user input
                    } else if (c.tool === 'spawn_agent') {
                        subagentPromises.push(this.doSpawn(c));
                    } else if (c.tool === 'run_command') {
                        results.push(await this.doCommand(c));
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
        for (const m of matchAllFull(buf, /<(read_file|list_files|search_files)([^>]*?)\/?>/g)) push(m[1], m[2] || '', '', m[0]);
        for (const m of matchAllFull(buf, /<edit([^>]*?)>([\s\S]*?)<\/edit>/g)) push('edit', m[1] || '', m[2] || '', m[0]);
        for (const m of matchAllFull(buf, /<create([^>]*?)>([\s\S]*?)<\/create>/g)) push('create', m[1] || '', m[2] || '', m[0]);
        for (const m of matchAllFull(buf, /<ask_user>([\s\S]*?)<\/ask_user>/g)) push('ask_user', '', m[1] || '', m[0]);
        for (const m of matchAllFull(buf, /<spawn_agent([^>]*?)\/?>/g)) push('spawn_agent', m[1] || '', '', m[0]);
        for (const m of matchAllFull(buf, /<run_command([^>]*?)\/?>/g)) push('run_command', m[1] || '', '', m[0]);
        for (const m of matchAllFull(buf, /<run_code([^>]*?)>([\s\S]*?)<\/run_code>/g)) push('run_code', m[1] || '', m[2] || '', m[0]);
        // Keep document order so a write/ask appearing before reads is handled correctly.
        calls.sort((a, b) => buf.indexOf(a.raw) - buf.indexOf(b.raw));
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
        const mode = this.d.getMode();
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
        // auto-edit / autonomous
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

        try {
            const profile = getProfileByRole(role);
            const sysPrompt = profile.systemPrompt + `\n\nYour specific task is: "${task}".`;

            const subagent = new AgentRunner({
                post: (msg) => {
                    if (msg.command === 'agentStatus') {
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
                        this.d.post({ command: 'agentProgress', id, log: `[Plan] ${JSON.stringify(msg.tasks)}` });
                    } else if (msg.command === 'agentProse') {
                        this.d.post({ command: 'agentProgress', id, log: msg.text });
                    } else if (msg.command === 'agentError') {
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

            this.d.post({ command: 'agentProgress', id, percentage: 100, log: 'Worker execution complete.' });
            this.d.post({ command: 'agentFinish', id, success: true, log: '\n--- Worker Finished ---' });
            return `[Subagent ${role}] completed task: ${task}. Result:\n${finalText}`;
        } catch (e: any) {
            this.d.post({ command: 'agentFinish', id, success: false, log: `\nError encountered: ${e.message}` });
            return `[Subagent ${role}] failed task: ${task}. Error: ${e.message}`;
        }
    }

    private async doCommand(c: ToolCall, bypassAsk = false): Promise<string> {
        const cmd = c.attrs.cmd;
        if (!cmd) return '[run_command] Error: no command specified.';

        const mode = this.d.getMode();
        if (mode === 'ask' && !bypassAsk) {
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
        if (mode === 'ask') {
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
}

// ---- helpers ----
function matchAll(s: string, rx: RegExp): string[] { const out: string[] = []; let m; while ((m = rx.exec(s)) !== null) out.push(m[1]); return out; }
function matchAllFull(s: string, rx: RegExp): RegExpExecArray[] { const out: RegExpExecArray[] = []; let m; while ((m = rx.exec(s)) !== null) out.push(m); return out; }
function matchAllPairs(s: string, rx: RegExp): [string, string][] { const out: [string, string][] = []; let m; while ((m = rx.exec(s)) !== null) out.push([m[1], m[2]]); return out; }
function stripTags(s: string): string {
    return s
        .replace(/<think\b[^>]*>[\s\S]*?<\/think>/g, '')
        .replace(/<status>[\s\S]*?<\/status>/g, '')
        .replace(/<task_list>[\s\S]*?<\/task_list>/g, '')
        .replace(/<edit[^>]*?>[\s\S]*?<\/edit>/g, '')
        .replace(/<create[^>]*?>[\s\S]*?<\/create>/g, '')
        .replace(/<ask_user>[\s\S]*?<\/ask_user>/g, '')
        .replace(/<spawn_agent[^>]*?\/?>/g, '')
        .replace(/<run_command[^>]*?\/?>/g, '')
        .replace(/<run_code[^>]*?>[\s\S]*?<\/run_code>/g, '')
        .replace(/<(read_file|list_files|search_files)[^>]*?\/?>/g, '');
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
