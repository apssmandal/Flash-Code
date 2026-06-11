import { describe, it, expect, vi, afterEach } from 'vitest';
import { safeFetch } from '../src/providers/http';
import { OverloadError, CancelledError } from '../src/core/errors';

afterEach(() => vi.unstubAllGlobals());

describe('safeFetch network resilience', () => {
  it('passes through a successful response', async () => {
    const res = new Response('ok');
    vi.stubGlobal('fetch', vi.fn(async () => res));
    expect(await safeFetch('https://x', {})).toBe(res);
  });

  it('maps a network throw to a retryable OverloadError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    await expect(safeFetch('https://x', {})).rejects.toBeInstanceOf(OverloadError);
  });

  it('propagates a user abort as CancelledError', async () => {
    const ac = new AbortController();
    ac.abort();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('Aborted', 'AbortError'); }));
    await expect(safeFetch('https://x', {}, ac.signal)).rejects.toBeInstanceOf(CancelledError);
  });
});
