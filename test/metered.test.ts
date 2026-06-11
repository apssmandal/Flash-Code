import { describe, it, expect } from 'vitest';
import { meterProvider } from '../src/providers/metered';
import type { Provider, StreamEvent, UnifiedRequest } from '../src/providers/types';

function fakeProvider(events: StreamEvent[], opts: { throwAfter?: number } = {}): Provider {
  return {
    id: 'fake',
    label: 'Fake',
    capabilities: { tools: true, vision: false, thinking: false } as any,
    models: () => ['m'],
    defaultModel: () => 'm',
    async *stream(): AsyncIterable<StreamEvent> {
      let i = 0;
      for (const e of events) {
        if (opts.throwAfter !== undefined && i === opts.throwAfter) throw new Error('boom');
        yield e;
        i++;
      }
    },
  };
}

const req: UnifiedRequest = { model: 'm', messages: [], genConfig: {} as any };

async function drain(p: Provider): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of p.stream(req)) out.push(e);
  return out;
}

describe('meterProvider', () => {
  it('records once per call using the LAST (cumulative) usage values, not the sum', async () => {
    const calls: any[] = [];
    // Gemini-style: cumulative usage on every chunk
    const p = meterProvider(
      fakeProvider([
        { type: 'text', text: 'hi' },
        { type: 'usage', inputTokens: 100, outputTokens: 5 },
        { type: 'text', text: ' there' },
        { type: 'usage', inputTokens: 100, outputTokens: 12 },
        { type: 'finish', reason: 'stop' },
      ]),
      (provider, model, i, o) => calls.push({ provider, model, i, o }),
    );
    const events = await drain(p);
    expect(events).toHaveLength(5); // all events pass through unchanged
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ provider: 'fake', model: 'm', i: 100, o: 12 });
  });

  it('merges separately-reported input and output (Anthropic-style)', async () => {
    const calls: any[] = [];
    const p = meterProvider(
      fakeProvider([
        { type: 'usage', inputTokens: 300 },   // message_start
        { type: 'text', text: 'x' },
        { type: 'usage', outputTokens: 42 },    // message_delta
        { type: 'finish', reason: 'stop' },
      ]),
      (_pv, _m, i, o) => calls.push({ i, o }),
    );
    await drain(p);
    expect(calls).toEqual([{ i: 300, o: 42 }]);
  });

  it('does not record when no usage event was seen', async () => {
    const calls: any[] = [];
    const p = meterProvider(
      fakeProvider([{ type: 'text', text: 'no usage' }, { type: 'finish', reason: 'stop' }]),
      () => calls.push(1),
    );
    await drain(p);
    expect(calls).toHaveLength(0);
  });

  it('still records partial usage when the stream throws mid-way', async () => {
    const calls: any[] = [];
    const p = meterProvider(
      fakeProvider(
        [{ type: 'usage', inputTokens: 50, outputTokens: 3 }, { type: 'text', text: 'partial' }],
        { throwAfter: 1 },
      ),
      (_pv, _m, i, o) => calls.push({ i, o }),
    );
    await expect(drain(p)).rejects.toThrow('boom');
    expect(calls).toEqual([{ i: 50, o: 3 }]); // finally-block recorded what we saw
  });
});
