/**
 * Lightweight intent classifier. Makes ONE cheap, short-output call to the
 * active provider to route a message: general → answer directly; codebase →
 * read-only understanding; agentic → full tool loop. Bounded by an 8s timeout
 * and a safe `agentic` fallback so it never blocks or misfires into doing
 * nothing.
 */

import type { Provider } from '../providers/types';
import { TRIAGE_PROMPT, triageUserMessage } from '../prompts/triage';
import { createLogger } from './logger';

const log = createLogger('triage');
export type Route = 'general' | 'codebase' | 'agentic';

export async function classifyIntent(
  provider: Provider,
  model: string,
  text: string,
  recent: string[],
  signal?: AbortSignal,
): Promise<Route> {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), 8000);

  try {
    let out = '';
    for await (const ev of provider.stream(
      {
        model,
        system: TRIAGE_PROMPT,
        messages: [{ role: 'user', content: triageUserMessage(text, recent) }],
        genConfig: { temperature: 0, maxOutputTokens: 16 },
      },
      ctrl.signal,
    )) {
      if (ev.type === 'text') out += ev.text;
    }
    return parseRoute(out);
  } catch (e: any) {
    log.warn(`classify failed (${e?.message}) — defaulting to agentic`);
    return 'agentic';
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export function parseRoute(raw: string): Route {
  const s = (raw || '').toLowerCase();
  if (/\bgeneral\b/.test(s)) return 'general';
  if (/\bcodebase\b/.test(s)) return 'codebase';
  return 'agentic';
}
