/**
 * ToolContext — the host capabilities a tool needs, behind an interface so tool
 * handlers never import `vscode` directly and are fully unit-testable with a
 * fake host. The real implementation (hostToolContext) wraps vscode.workspace.fs,
 * child_process, etc.; tests pass an in-memory fake.
 */

import type { AgentEvent, AgentMode, EmitFn } from './events';

export interface DirEntry { name: string; isDir: boolean; }
export interface FileStat { size: number; mtime: number; }
export interface CommandResult { code: number | null; output: string; }

export interface ToolContext {
  // --- filesystem (workspace-relative paths) ---
  readFile(rel: string): Promise<string>;
  writeFile(rel: string, content: string): Promise<void>;
  fileExists(rel: string): Promise<boolean>;
  deleteFile(rel: string): Promise<void>;
  renameFile(src: string, dest: string): Promise<void>;
  copyFile(src: string, dest: string): Promise<void>;
  listDir(rel: string): Promise<DirEntry[]>;
  createDir(rel: string): Promise<void>;
  stat(rel: string): Promise<FileStat>;
  projectTree(): Promise<string>;
  allFiles(): Promise<string[]>;
  workspaceRoot(): string | undefined;

  // --- execution ---
  /** Run a shell command, streaming output via `onOutput`. */
  runCommand(command: string, onOutput: (chunk: string) => void, signal?: AbortSignal): Promise<CommandResult>;
  /** Run a named executable with an explicit argv array (no shell). */
  runExec(file: string, args: string[], onOutput: (chunk: string) => void, signal?: AbortSignal): Promise<CommandResult>;

  // --- network ---
  fetchText(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<string>;

  // --- UI / control plane ---
  mode(): AgentMode;
  emit: EmitFn;
  /** Permission prompt for a command/script; resolves true if approved. */
  askApproval(kind: 'command' | 'code' | 'write', detail: string): Promise<boolean>;
  /** Interactive question → resolves with the user's answer string. */
  askUser(questions: any[]): Promise<string>;
  /** Show a diff and (in ask mode) wait for accept/reject. Returns true if applied. */
  presentDiff(path: string, oldText: string, newText: string): Promise<boolean>;
  /** Snapshot a file's prior state so a rewind can restore it. */
  recordSnapshot(rel: string, oldContent: string, existed: boolean): void;

  // --- subagents ---
  spawn(role: string, task: string): Promise<string>;
}

/** A tool handler: validate args, do the work, return the model-facing result. */
export type ToolHandler = (args: Record<string, any>, ctx: ToolContext, signal?: AbortSignal) => Promise<string>;

export type { AgentEvent };
