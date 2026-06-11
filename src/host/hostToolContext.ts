/**
 * Real ToolContext backed by VS Code APIs + child_process. The UI/control-plane
 * callbacks (emit, approvals, diff presentation, snapshots, subagent spawn) are
 * injected so this stays decoupled from the webview/session and unit-testable.
 *
 * Security: runExec uses spawn with an argv array and shell:false (no shell
 * interpolation); runCommand runs through the platform shell ONLY for the
 * explicit user-approved <run_command> tool.
 */

import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { stripVTControlCharacters } from 'util';
import type { CommandResult, DirEntry, FileStat, ToolContext } from '../core/toolContext';
import type { AgentEvent, AgentMode } from '../core/events';
import { getProjectTree, getAllFiles } from '../fileManager';

export interface HostToolPlane {
  emit: (ev: AgentEvent) => void;
  mode: () => AgentMode;
  askApproval: (kind: 'command' | 'code' | 'write', detail: string) => Promise<boolean>;
  askUser: (questions: any[]) => Promise<string>;
  presentDiff: (path: string, oldText: string, newText: string) => Promise<boolean>;
  recordSnapshot: (rel: string, oldContent: string, existed: boolean) => void;
  spawn: (role: string, task: string) => Promise<string>;
  /** workspace root override (subagents may run in a worktree) */
  root?: () => vscode.Uri | undefined;
}

const dec = (b: Uint8Array) => Buffer.from(b).toString('utf-8');
const enc = (s: string) => Buffer.from(s, 'utf-8');

export class HostToolContext implements ToolContext {
  constructor(private plane: HostToolPlane) {}

  private root(): vscode.Uri {
    const r = this.plane.root?.() ?? vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!r) throw new Error('No workspace folder is open.');
    return r;
  }
  private uri(rel: string): vscode.Uri { return vscode.Uri.joinPath(this.root(), rel); }

  workspaceRoot(): string | undefined {
    return (this.plane.root?.() ?? vscode.workspace.workspaceFolders?.[0]?.uri)?.fsPath;
  }

  async readFile(rel: string): Promise<string> { return dec(await vscode.workspace.fs.readFile(this.uri(rel))); }
  async writeFile(rel: string, content: string): Promise<void> { await vscode.workspace.fs.writeFile(this.uri(rel), enc(content)); }
  async fileExists(rel: string): Promise<boolean> { try { await vscode.workspace.fs.stat(this.uri(rel)); return true; } catch { return false; } }
  async deleteFile(rel: string): Promise<void> { await vscode.workspace.fs.delete(this.uri(rel)); }
  async renameFile(src: string, dest: string): Promise<void> { await vscode.workspace.fs.rename(this.uri(src), this.uri(dest)); }
  async copyFile(src: string, dest: string): Promise<void> { await vscode.workspace.fs.copy(this.uri(src), this.uri(dest), { overwrite: true }); }
  async createDir(rel: string): Promise<void> { await vscode.workspace.fs.createDirectory(this.uri(rel)); }

  async listDir(rel: string): Promise<DirEntry[]> {
    const entries = await vscode.workspace.fs.readDirectory(this.uri(rel));
    return entries.map(([name, type]) => ({ name, isDir: type === vscode.FileType.Directory }));
  }
  async stat(rel: string): Promise<FileStat> {
    const s = await vscode.workspace.fs.stat(this.uri(rel));
    return { size: s.size, mtime: s.mtime };
  }
  projectTree(): Promise<string> { return getProjectTree(); }
  allFiles(): Promise<string[]> { return getAllFiles(); }

  async runCommand(command: string, onOutput: (c: string) => void, signal?: AbortSignal): Promise<CommandResult> {
    const isWin = process.platform === 'win32';
    const shell = isWin ? 'powershell.exe' : 'bash';
    const args = isWin ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-c', command];
    return this.run(shell, args, onOutput, signal);
  }

  async runExec(file: string, args: string[], onOutput: (c: string) => void, signal?: AbortSignal): Promise<CommandResult> {
    return this.run(file, args, onOutput, signal);
  }

  private run(file: string, args: string[], onOutput: (c: string) => void, signal?: AbortSignal): Promise<CommandResult> {
    const cwd = this.workspaceRoot() ?? process.cwd();
    return new Promise<CommandResult>((resolve) => {
      const child = spawn(file, args, { cwd, env: { ...process.env, FORCE_COLOR: '1' }, shell: false });
      let out = '';
      const onData = (b: Buffer) => { const c = stripVTControlCharacters(b.toString('utf-8')); out += c; onOutput(c); };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      if (signal) signal.addEventListener('abort', () => child.kill(), { once: true });
      child.on('close', (code) => resolve({ code, output: out }));
      child.on('error', (err) => resolve({ code: null, output: out + '\n' + err.message }));
    });
  }

  async fetchText(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<string> {
    const res = await fetch(url, init as any);
    return res.text();
  }

  mode(): AgentMode { return this.plane.mode(); }
  emit = (ev: AgentEvent) => this.plane.emit(ev);
  askApproval(kind: 'command' | 'code' | 'write', detail: string) { return this.plane.askApproval(kind, detail); }
  askUser(questions: any[]) { return this.plane.askUser(questions); }
  presentDiff(path: string, oldText: string, newText: string) { return this.plane.presentDiff(path, oldText, newText); }
  recordSnapshot(rel: string, oldContent: string, existed: boolean) { this.plane.recordSnapshot(rel, oldContent, existed); }
  spawn(role: string, task: string) { return this.plane.spawn(role, task); }
}
