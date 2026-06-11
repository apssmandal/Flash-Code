/**
 * Pure, host-agnostic model for per-session / per-model token accounting.
 * No `vscode` import — the host (UsageTracker) owns persistence and joins this
 * data with session titles for display. Each model API call contributes one
 * `call` plus its input (sent) / output (received) token deltas.
 */

export interface ModelUsage {
  provider: string;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface SessionUsage {
  sessionId: string;
  /** Epoch ms of the last recorded call (passed in — the core never reads the clock). */
  updated: number;
  /** Keyed by `"provider/model"`. */
  models: Record<string, ModelUsage>;
}

export type UsageStore = Record<string, SessionUsage>;

export interface Totals { calls: number; inputTokens: number; outputTokens: number; }

const modelKey = (provider: string, model: string) => `${provider}/${model}`;

/**
 * Immutably record one API call. Returns a new store with the session's
 * per-model counters advanced. `at` is the timestamp to stamp (caller supplies
 * it so this stays pure/deterministic).
 */
export function recordCall(
  store: UsageStore,
  sessionId: string,
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  at: number,
): UsageStore {
  const prevSession = store[sessionId];
  const models = { ...(prevSession?.models ?? {}) };
  const k = modelKey(provider, model);
  const prev = models[k];
  models[k] = {
    provider,
    model,
    calls: (prev?.calls ?? 0) + 1,
    inputTokens: (prev?.inputTokens ?? 0) + (inputTokens || 0),
    outputTokens: (prev?.outputTokens ?? 0) + (outputTokens || 0),
  };
  return {
    ...store,
    [sessionId]: { sessionId, updated: at, models },
  };
}

export function sessionTotals(s: SessionUsage): Totals {
  return Object.values(s.models).reduce<Totals>(
    (acc, m) => ({
      calls: acc.calls + m.calls,
      inputTokens: acc.inputTokens + m.inputTokens,
      outputTokens: acc.outputTokens + m.outputTokens,
    }),
    { calls: 0, inputTokens: 0, outputTokens: 0 },
  );
}

export function grandTotals(store: UsageStore): Totals {
  return Object.values(store).reduce<Totals>(
    (acc, s) => {
      const t = sessionTotals(s);
      return {
        calls: acc.calls + t.calls,
        inputTokens: acc.inputTokens + t.inputTokens,
        outputTokens: acc.outputTokens + t.outputTokens,
      };
    },
    { calls: 0, inputTokens: 0, outputTokens: 0 },
  );
}

/** Compact human-readable token count: 950 → "950", 1234 → "1.2k", 3_400_000 → "3.4M". */
export function formatTokens(n: number): string {
  if (!n || n < 0) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
}
