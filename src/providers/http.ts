/**
 * Shared HTTP/SSE helpers for providers: typed-error classification (so the
 * KeyPool can make cooldown/retry decisions) and a Server-Sent-Events line
 * reader over a fetch Response body.
 */

import { AuthError, OverloadError, RateLimitError, FlashError, CancelledError } from '../core/errors';

/**
 * fetch() wrapper that turns transient network failures ("fetch failed",
 * ECONNRESET, ETIMEDOUT, socket hang up…) into a retryable OverloadError so the
 * KeyPool reroutes/backs off instead of aborting the whole run. A genuine
 * user-abort (the signal fired) propagates so cancellation still works.
 */
export async function safeFetch(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e: any) {
    if (signal?.aborted || e?.name === 'AbortError') throw new CancelledError();
    throw new OverloadError(`Network error: ${e?.message ?? String(e)}`);
  }
}

/** Translate an HTTP status into a typed error the KeyPool understands. */
export function classifyStatus(status: number, retryAfterHeader: string | null, body: string): never {
  if (status === 429) {
    const secs = parseInt(retryAfterHeader || '', 10);
    throw new RateLimitError(Number.isFinite(secs) ? secs * 1000 : 30_000, `Rate limited (429)`);
  }
  if (status === 401 || status === 403) throw new AuthError(`Auth failed (${status}): ${body.slice(0, 200)}`);
  if (status === 500 || status === 502 || status === 503 || status === 529) {
    throw new OverloadError(`Provider overloaded (${status})`);
  }
  throw new FlashError(`HTTP ${status}: ${body.slice(0, 400)}`);
}

/** Read a fetch Response body as SSE and yield each `data:` payload line. */
export async function* sseData(res: Response, signal?: AbortSignal): AsyncIterable<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const ln of lines) {
        const line = ln.trim();
        if (line.startsWith('data:')) {
          const payload = line.slice(5).trim();
          if (payload) yield payload;
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

/** Read full body text, tolerating abort. */
export async function readError(res: Response): Promise<string> {
  try { return await res.text(); } catch { return ''; }
}
