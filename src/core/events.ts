/**
 * Agent-level events emitted by the loop and tools toward the UI. Distinct from
 * provider `StreamEvent`s: these are higher-level, UI-facing, and stable across
 * providers (the webview renders only these).
 */

import type { DiffRow } from '../diffUtils';

export type AgentMode = 'ask' | 'auto-edit' | 'plan' | 'autonomous';

export interface TaskItem { id: string; desc: string; status: 'pending' | 'running' | 'done' | 'failed'; }

export type AgentEvent =
  | { type: 'status'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'prose'; text: string }
  | { type: 'tasks'; tasks: TaskItem[] }
  | { type: 'tool_start'; id: string; tool: string; detail: string }
  | { type: 'tool_output'; id: string; text: string }
  | { type: 'tool_result'; id: string; tool: string; ok: boolean; summary: string }
  | { type: 'diff'; diffId?: string; path: string; rows: DiffRow[]; badge: string; applied?: boolean }
  | { type: 'ask_user'; questions: any[] }
  | { type: 'ask_command'; cmdId: string; command: string; threadLabel?: string }
  | { type: 'ask_code'; cmdId: string; lang: string; code: string; threadLabel?: string }
  | { type: 'spawn'; id: string; role: string; task: string }
  | { type: 'progress'; id: string; percentage?: number; log: string }
  | { type: 'finish'; id: string; success: boolean; log?: string }
  | { type: 'error'; message: string }
  | { type: 'done' };

export type EmitFn = (ev: AgentEvent) => void;
