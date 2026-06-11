/**
 * Generalized API-key rotation pool — the heart of free-tier survival.
 *
 * Originally Gemini-only (taskOrchestrator); now reusable by any provider.
 * Provides:
 *   - round-robin selection balanced by in-flight lease count
 *   - per-key cooldown on 429 / auth failure
 *   - global RPM pacing (sliding 60s window) across all keys
 *   - retry orchestration via `withRotation()` that reroutes on RateLimitError,
 *     disables keys on AuthError, and backs off on OverloadError
 *
 * Timing is injectable (`now`/`sleep`) so the rotation logic is unit-testable
 * with fake clocks and no real waiting.
 */

import { AuthError, NoKeyError, OverloadError, RateLimitError, CancelledError } from '../core/errors';
import type { StreamEvent } from './types';

export interface KeyStatus {
  idx: number;
  status: 'ok' | 'limited' | 'error';
  cooldownMs: number;
}

export interface KeyLease {
  key: string;
  idx: number;
  release(): void;
  cooldown(ms: number): void;
  disable(ms?: number): void;
}

export interface KeyPoolOptions {
  getKeys: () => string[];
  rpm?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** max ms to wait for a cooling-down key before rejecting */
  maxWaitMs?: number;
}

const AUTH_COOLDOWN_MS = 24 * 3600 * 1000;

export class KeyPool {
  private readonly getKeys: () => string[];
  private readonly rpm: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxWaitMs: number;

  private keyIndex = 0;
  private cooldownUntil = new Map<number, number>();
  private errored = new Set<number>();
  private active = new Map<number, number>();
  private dispatchTimes: number[] = [];
  /** serializes selection + pacing so concurrent acquires stay fair */
  private gate: Promise<void> = Promise.resolve();

  constructor(opts: KeyPoolOptions) {
    this.getKeys = opts.getKeys;
    this.rpm = opts.rpm ?? 15;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxWaitMs = opts.maxWaitMs ?? 60_000;
  }

  getStatuses(): KeyStatus[] {
    const keys = this.getKeys();
    const t = this.now();
    return keys.map((_, idx) => {
      const until = this.cooldownUntil.get(idx) ?? 0;
      if (until <= t) { this.errored.delete(idx); return { idx, status: 'ok', cooldownMs: 0 }; }
      return { idx, status: this.errored.has(idx) ? 'error' : 'limited', cooldownMs: until - t } as KeyStatus;
    });
  }

  /** Acquire a usable key, honoring cooldowns and RPM pacing. */
  async acquire(signal?: AbortSignal): Promise<KeyLease> {
    // Chain through the gate so selection is atomic across concurrent callers.
    const prev = this.gate;
    let releaseGate!: () => void;
    this.gate = new Promise<void>((r) => (releaseGate = r));
    await prev;
    try {
      return await this.selectLoop(signal);
    } finally {
      releaseGate();
    }
  }

  private async selectLoop(signal?: AbortSignal): Promise<KeyLease> {
    for (;;) {
      if (signal?.aborted) throw new CancelledError();
      const keys = this.getKeys();
      if (!keys.length) throw new NoKeyError();

      const t = this.now();
      let bestIdx = -1;
      let minActive = Infinity;
      for (let i = 0; i < keys.length; i++) {
        const idx = (this.keyIndex + i) % keys.length;
        if ((this.cooldownUntil.get(idx) ?? 0) > t) continue;
        const a = this.active.get(idx) ?? 0;
        if (a < minActive) { minActive = a; bestIdx = idx; }
      }

      if (bestIdx === -1) {
        const waits = Array.from(this.cooldownUntil.values()).filter((c) => c > t).map((c) => c - t);
        const minWait = waits.length ? Math.min(...waits) : this.maxWaitMs;
        if (minWait > this.maxWaitMs) {
          throw new RateLimitError(minWait, `All keys cooling down (min ${Math.ceil(minWait / 1000)}s)`);
        }
        await this.sleep(Math.min(minWait, 1000));
        continue;
      }

      // RPM pacing: keep the 60s window under the cap.
      this.dispatchTimes = this.dispatchTimes.filter((ts) => t - ts < 60_000);
      if (this.dispatchTimes.length >= this.rpm) {
        const oldest = this.dispatchTimes[0];
        await this.sleep(Math.max(0, 60_000 - (t - oldest)) + 10);
        continue;
      }

      this.keyIndex = (bestIdx + 1) % keys.length;
      this.active.set(bestIdx, (this.active.get(bestIdx) ?? 0) + 1);
      this.dispatchTimes.push(this.now());
      return this.makeLease(keys[bestIdx], bestIdx);
    }
  }

  private makeLease(key: string, idx: number): KeyLease {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.active.set(idx, Math.max(0, (this.active.get(idx) ?? 1) - 1));
    };
    return {
      key,
      idx,
      release,
      cooldown: (ms: number) => { this.cooldownUntil.set(idx, this.now() + ms); },
      disable: (ms = AUTH_COOLDOWN_MS) => { this.cooldownUntil.set(idx, this.now() + ms); this.errored.add(idx); },
    };
  }

  /**
   * Run a streaming operation with full rotation/retry. `doFetch` must perform
   * the request, throw a typed error on bad status BEFORE yielding, then yield
   * StreamEvents. On RateLimitError we reroute to another key; on AuthError we
   * disable the key; on OverloadError we back off and retry.
   */
  async *withRotation(
    doFetch: (key: string) => AsyncIterable<StreamEvent>,
    signal?: AbortSignal,
    maxAttempts = 6,
  ): AsyncIterable<StreamEvent> {
    let attempt = 0;
    for (;;) {
      const lease = await this.acquire(signal);
      let started = false;
      try {
        for await (const ev of doFetch(lease.key)) {
          started = true;
          yield ev;
        }
        return;
      } catch (e) {
        if (started) throw e; // don't retry a partially-streamed response
        attempt++;
        if (attempt >= maxAttempts) throw e;
        if (e instanceof RateLimitError) { lease.cooldown(e.retryAfterMs); continue; }
        if (e instanceof AuthError) { lease.disable(); continue; }
        if (e instanceof OverloadError) { await this.sleep(1000 * attempt); continue; }
        throw e;
      } finally {
        lease.release();
      }
    }
  }
}
