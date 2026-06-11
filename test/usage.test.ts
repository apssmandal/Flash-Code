import { describe, it, expect } from 'vitest';
import { recordCall, sessionTotals, grandTotals, formatTokens, type UsageStore } from '../src/core/usage';

describe('usage accounting', () => {
  it('accumulates calls and tokens per provider/model within a session', () => {
    let store: UsageStore = {};
    store = recordCall(store, 's1', 'gemini', 'gemini-2.0-flash', 100, 40, 1);
    store = recordCall(store, 's1', 'gemini', 'gemini-2.0-flash', 50, 10, 2);
    store = recordCall(store, 's1', 'anthropic', 'claude-opus', 200, 80, 3);

    const models = store['s1'].models;
    expect(models['gemini/gemini-2.0-flash']).toEqual({ provider: 'gemini', model: 'gemini-2.0-flash', calls: 2, inputTokens: 150, outputTokens: 50 });
    expect(models['anthropic/claude-opus'].calls).toBe(1);
    expect(store['s1'].updated).toBe(3); // stamped with the supplied timestamp

    expect(sessionTotals(store['s1'])).toEqual({ calls: 3, inputTokens: 350, outputTokens: 130 });
  });

  it('keeps sessions separate and sums them in grandTotals', () => {
    let store: UsageStore = {};
    store = recordCall(store, 'a', 'openai', 'gpt', 10, 5, 1);
    store = recordCall(store, 'b', 'openai', 'gpt', 20, 7, 2);
    expect(Object.keys(store).sort()).toEqual(['a', 'b']);
    expect(grandTotals(store)).toEqual({ calls: 2, inputTokens: 30, outputTokens: 12 });
  });

  it('treats undefined token counts as zero', () => {
    let store: UsageStore = {};
    // @ts-expect-error intentionally passing undefined like a provider that omits a field
    store = recordCall(store, 's', 'ollama', 'qwen', undefined, 12, 1);
    expect(store['s'].models['ollama/qwen']).toMatchObject({ inputTokens: 0, outputTokens: 12, calls: 1 });
  });

  it('does not mutate the previous store (immutability)', () => {
    const a: UsageStore = {};
    const b = recordCall(a, 's', 'p', 'm', 1, 1, 1);
    expect(a).toEqual({});
    expect(b).not.toBe(a);
  });

  it('formats token counts compactly', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(1234)).toBe('1.2k');
    expect(formatTokens(1000)).toBe('1k');
    expect(formatTokens(3_400_000)).toBe('3.4M');
  });
});
