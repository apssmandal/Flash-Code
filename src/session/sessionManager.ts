/**
 * Session state + persistence. Owns the current chat (ChatMessage[] for the
 * model, plus a UI-facing turn list), file snapshots for rewind, a rolling
 * summary for compaction, and the saved-session index. Per-workspace scoped via
 * storage key helpers. Caps retained history so globalState never grows
 * unbounded (a bug in the legacy implementation).
 */

import * as vscode from 'vscode';
import type { ChatMessage } from '../providers/types';
import type { ChatTurn, SessionInfo } from './types';
import { chatKey, summaryKey, lastKey, sessionsKey } from '../storage';
import { sessionEvents } from './sessionEvents';

const TITLES_KEY = 'fc.titles';

interface Snapshot { path: string; content: string; existed: boolean; }

const MAX_TURNS = 200;

/** Collision-resistant id even when created within the same millisecond. */
function newId(): string { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

interface Persisted { turns: ChatTurn[]; messages: ChatMessage[]; }

/** Rough character size of a model message (content + tool payloads), for token estimates. */
function msgChars(m: ChatMessage): number {
  let n = m.content?.length ?? 0;
  if (m.toolCalls?.length) n += JSON.stringify(m.toolCalls).length;
  if (m.toolResult) n += (m.toolResult.content?.length ?? 0) + m.toolResult.name.length;
  return n;
}

export class SessionManager {
  private id: string;
  private turns: ChatTurn[] = [];
  private messages: ChatMessage[] = [];
  private summary = '';
  private snapshots = new Map<number, Snapshot[]>();

  constructor(private ctx: vscode.ExtensionContext) {
    this.id = newId();
    const last = ctx.globalState.get<string>(lastKey());
    if (last) this.load(last);
  }

  get sessionId(): string { return this.id; }
  get uiTurns(): ChatTurn[] { return this.turns; }
  /** Trimmed model history for the next request. */
  history(): ChatMessage[] { return this.messages.slice(-MAX_TURNS); }
  get rollingSummary(): string { return this.summary; }
  setSummary(s: string) { this.summary = s; }
  /** Count of model-facing messages currently in context (drives compaction). */
  get modelMessageCount(): number { return this.messages.length; }

  /**
   * Real compaction: set the (cumulative) rolling summary and DROP all but the
   * last `keep` model messages, so the context window actually shrinks. The UI
   * turn list (`this.turns`) is left intact so the chat transcript stays
   * scrollable; only what's sent to the model is trimmed.
   * Returns the number of messages dropped and an estimate of the tokens freed
   * (≈ chars/4 over the dropped messages' content + tool payloads).
   */
  compactInto(summary: string, keep: number): { dropped: number; freedTokens: number } {
    this.summary = summary;
    const before = this.messages.length;
    if (before <= keep) return { dropped: 0, freedTokens: 0 };
    const droppedMsgs = this.messages.slice(0, before - keep);
    const chars = droppedMsgs.reduce((n, m) => n + msgChars(m), 0);
    this.messages = this.messages.slice(-keep);
    return { dropped: before - this.messages.length, freedTokens: Math.ceil(chars / 4) };
  }

  /** Index a user turn lands at (for rewind anchoring). */
  addUser(content: string, attachments?: ChatTurn['attachments']): number {
    this.turns.push({ role: 'user', content, attachments });
    this.messages.push({ role: 'user', content });
    return this.turns.length - 1;
  }

  addAssistant(content: string): void {
    this.turns.push({ role: 'assistant', content });
    this.messages.push({ role: 'assistant', content });
  }

  /** Record raw model-facing messages (assistant tool calls + tool results) so
   * the next turn has full context, without polluting the UI turn list. */
  recordRaw(msgs: ChatMessage[]): void {
    this.messages.push(...msgs);
  }

  snapshot(turnIndex: number, path: string, content: string, existed: boolean): void {
    const arr = this.snapshots.get(turnIndex) ?? [];
    arr.push({ path, content, existed });
    this.snapshots.set(turnIndex, arr);
  }

  /** Restore files changed at/after a turn and truncate history to it. */
  async rewind(turnIndex: number, root: vscode.Uri): Promise<void> {
    for (const [idx, snaps] of [...this.snapshots.entries()]) {
      if (idx < turnIndex) continue;
      for (const s of snaps) {
        const uri = vscode.Uri.joinPath(root, s.path);
        if (s.existed) await vscode.workspace.fs.writeFile(uri, Buffer.from(s.content, 'utf-8'));
        else { try { await vscode.workspace.fs.delete(uri); } catch { /* already gone */ } }
      }
      this.snapshots.delete(idx);
    }
    this.turns = this.turns.slice(0, turnIndex);
    // Drop model messages from that user turn onward (best-effort by count).
    this.messages = this.messages.slice(0, turnIndex);
    this.save();
  }

  newChat(): void {
    this.id = newId();
    this.turns = []; this.messages = []; this.summary = ''; this.snapshots.clear();
    this.ctx.globalState.update(lastKey(), this.id);
  }

  clear(): void { this.turns = []; this.messages = []; this.summary = ''; this.snapshots.clear(); this.save(); }

  load(id: string): void {
    const blob = this.ctx.globalState.get<Persisted>(chatKey(id));
    this.id = id;
    this.turns = blob?.turns ?? [];
    this.messages = blob?.messages ?? this.turns.map((t) => ({ role: t.role, content: t.content }));
    this.summary = this.ctx.globalState.get<string>(summaryKey(id)) ?? '';
    this.snapshots.clear();
    this.ctx.globalState.update(lastKey(), id);
  }

  save(): void {
    if (this.messages.length > MAX_TURNS) this.messages = this.messages.slice(-MAX_TURNS);
    const blob: Persisted = { turns: this.turns, messages: this.messages };
    this.ctx.globalState.update(chatKey(this.id), blob);
    this.ctx.globalState.update(summaryKey(this.id), this.summary);
    this.ctx.globalState.update(lastKey(), this.id);
    this.indexSession();
  }

  private indexSession(): void {
    if (this.turns.length === 0) return; // don't index an empty chat
    const titles = this.ctx.globalState.get<Record<string, string>>(TITLES_KEY, {});
    const title = titles[this.id] || this.turns.find((t) => t.role === 'user')?.content.slice(0, 48) || 'New chat';
    const info: SessionInfo = { id: this.id, title, date: new Date().toLocaleDateString(), count: this.turns.length };
    const list = this.ctx.globalState.get<SessionInfo[]>(sessionsKey(), []).filter((s) => s.id !== this.id);
    list.unshift(info);
    if (list.length > 50) list.length = 50;
    this.ctx.globalState.update(sessionsKey(), list);
    sessionEvents.fire();
  }

  listSessions(): SessionInfo[] { return this.ctx.globalState.get<SessionInfo[]>(sessionsKey(), []); }

  renameSession(id: string, title: string): void {
    const clean = title.trim().slice(0, 80);
    if (!clean) return;
    const titles = this.ctx.globalState.get<Record<string, string>>(TITLES_KEY, {});
    titles[id] = clean;
    this.ctx.globalState.update(TITLES_KEY, titles);
    const list = this.listSessions().map((s) => (s.id === id ? { ...s, title: clean } : s));
    this.ctx.globalState.update(sessionsKey(), list);
    sessionEvents.fire();
  }

  deleteSession(id: string): void {
    const list = this.listSessions().filter((s) => s.id !== id);
    this.ctx.globalState.update(sessionsKey(), list);
    this.ctx.globalState.update(chatKey(id), undefined);
    this.ctx.globalState.update(summaryKey(id), undefined);
    if (id === this.id) this.newChat();
    sessionEvents.fire();
  }
}
