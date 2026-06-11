/**
 * Per-workspace token-usage tracker (host singleton, mirrors the
 * DashboardController static pattern). Records one entry per completed model
 * API call — fed by the metering proxy (src/providers/metered.ts) — and
 * persists to globalState. The sidebar reads `snapshot()` to render the inline
 * "Usage & Tokens" section; `changed` fires so an open panel can refresh.
 */
import * as vscode from 'vscode';
import { recordCall, grandTotals, sessionTotals, type UsageStore, type ModelUsage, type Totals } from '../core/usage';
import type { SessionInfo } from '../session/types';
import { usageKey, sessionsKey } from '../storage';

export interface UsageSessionView {
  sessionId: string;
  title: string;
  updated: number;
  totals: Totals;
  models: ModelUsage[];
}
export interface UsageSnapshot {
  grand: Totals;
  sessions: UsageSessionView[];
}

export class UsageTracker {
  static instance: UsageTracker;
  /** Fires whenever recorded usage changes (record/clear). */
  static readonly changed = new vscode.EventEmitter<void>();

  private store: UsageStore;

  private constructor(private ctx: vscode.ExtensionContext) {
    this.store = ctx.globalState.get<UsageStore>(usageKey()) ?? {};
  }

  static init(ctx: vscode.ExtensionContext): void {
    UsageTracker.instance = new UsageTracker(ctx);
  }

  /** Record one completed API call's token totals against a session. */
  record(sessionId: string, provider: string, model: string, inputTokens: number, outputTokens: number): void {
    if (!sessionId || (!inputTokens && !outputTokens)) return;
    this.store = recordCall(this.store, sessionId, provider, model, inputTokens, outputTokens, Date.now());
    void this.ctx.globalState.update(usageKey(), this.store);
    UsageTracker.changed.fire();
  }

  clear(): void {
    this.store = {};
    void this.ctx.globalState.update(usageKey(), this.store);
    UsageTracker.changed.fire();
  }

  clearSession(id: string): void {
    if (!(id in this.store)) return;
    const next: UsageStore = { ...this.store };
    delete next[id];
    this.store = next;
    void this.ctx.globalState.update(usageKey(), this.store);
    UsageTracker.changed.fire();
  }

  /** Store joined with session titles, sorted newest-first, for the webview. */
  snapshot(): UsageSnapshot {
    const titles = new Map<string, string>(
      this.ctx.globalState.get<SessionInfo[]>(sessionsKey(), []).map((s) => [s.id, s.title]),
    );
    const sessions: UsageSessionView[] = Object.values(this.store)
      .map((s) => ({
        sessionId: s.sessionId,
        title: titles.get(s.sessionId) || 'Untitled chat',
        updated: s.updated,
        totals: sessionTotals(s),
        models: Object.values(s.models).sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens)),
      }))
      .sort((a, b) => b.updated - a.updated);
    return { grand: grandTotals(this.store), sessions };
  }
}
