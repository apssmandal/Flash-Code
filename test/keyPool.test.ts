import { describe, it, expect } from 'vitest';
import { KeyPool } from '../src/providers/keyPool';
import { RateLimitError, AuthError, NoKeyError } from '../src/core/errors';
import type { StreamEvent } from '../src/providers/types';

/** Deterministic clock: `sleep` advances virtual time instead of waiting. */
function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => { t += ms; },
    advance: (ms: number) => { t += ms; },
  };
}

async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('KeyPool rotation', () => {
  it('round-robins across keys on sequential acquire/release', async () => {
    const clock = fakeClock();
    const pool = new KeyPool({ getKeys: () => ['k1', 'k2', 'k3'], rpm: 1000, ...clock });
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      const lease = await pool.acquire();
      seen.push(lease.key);
      lease.release();
    }
    expect(seen).toEqual(['k1', 'k2', 'k3', 'k1', 'k2', 'k3']);
  });

  it('skips a key that is on cooldown', async () => {
    const clock = fakeClock();
    const pool = new KeyPool({ getKeys: () => ['k1', 'k2'], rpm: 1000, ...clock });
    const l1 = await pool.acquire();
    l1.cooldown(5000); // cool down k1
    l1.release();
    const l2 = await pool.acquire();
    expect(l2.key).toBe('k2');
    l2.release();
    const statuses = pool.getStatuses();
    expect(statuses[0].status).toBe('limited');
    expect(statuses[1].status).toBe('ok');
  });

  it('throws NoKeyError when the pool is empty', async () => {
    const pool = new KeyPool({ getKeys: () => [], ...fakeClock() });
    await expect(pool.acquire()).rejects.toBeInstanceOf(NoKeyError);
  });

  it('paces dispatches under the RPM cap', async () => {
    const clock = fakeClock();
    const pool = new KeyPool({ getKeys: () => ['k1'], rpm: 2, ...clock });
    const times: number[] = [];
    for (let i = 0; i < 4; i++) {
      const lease = await pool.acquire();
      times.push(clock.now());
      lease.release();
    }
    // After 2 dispatches the window is full, so the 3rd must wait ~60s.
    expect(times[2] - times[0]).toBeGreaterThanOrEqual(60_000);
  });
});

describe('KeyPool.withRotation', () => {
  it('reroutes to the next key after a RateLimitError before any output', async () => {
    const clock = fakeClock();
    const pool = new KeyPool({ getKeys: () => ['bad', 'good'], rpm: 1000, ...clock });
    const usedKeys: string[] = [];
    const stream = pool.withRotation(async function* (key) {
      usedKeys.push(key);
      if (key === 'bad') throw new RateLimitError(1000);
      yield { type: 'text', text: 'ok' } as StreamEvent;
      yield { type: 'finish', reason: 'stop' } as StreamEvent;
    });
    const events = await collect(stream);
    expect(usedKeys).toEqual(['bad', 'good']);
    expect(events.some((e) => e.type === 'text' && e.text === 'ok')).toBe(true);
  });

  it('disables a key on AuthError then succeeds on another', async () => {
    const clock = fakeClock();
    const pool = new KeyPool({ getKeys: () => ['expired', 'valid'], rpm: 1000, ...clock });
    const stream = pool.withRotation(async function* (key) {
      if (key === 'expired') throw new AuthError();
      yield { type: 'finish', reason: 'stop' } as StreamEvent;
    });
    const events = await collect(stream);
    expect(events).toHaveLength(1);
    expect(pool.getStatuses()[0].status).toBe('error');
  });

  it('does not retry once output has started streaming', async () => {
    const clock = fakeClock();
    const pool = new KeyPool({ getKeys: () => ['k1', 'k2'], rpm: 1000, ...clock });
    let calls = 0;
    const stream = pool.withRotation(async function* () {
      calls++;
      yield { type: 'text', text: 'partial' } as StreamEvent;
      throw new RateLimitError(1000);
    });
    await expect(collect(stream)).rejects.toBeInstanceOf(RateLimitError);
    expect(calls).toBe(1);
  });
});
