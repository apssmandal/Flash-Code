import { describe, it, expect } from 'vitest';
import { parseRoute, classifyIntent } from '../src/core/triage';
import type { Provider, StreamEvent, UnifiedRequest } from '../src/providers/types';

function provider(reply: string | (() => never)): Provider {
  return {
    id: 'fake', label: 'Fake', capabilities: { tools: true, vision: false, thinking: false },
    models: () => ['m'], defaultModel: () => 'm',
    async *stream(_r: UnifiedRequest): AsyncIterable<StreamEvent> {
      if (typeof reply === 'function') reply();
      yield { type: 'text', text: reply as string };
      yield { type: 'finish', reason: 'stop' };
    },
  };
}

describe('triage parseRoute', () => {
  it('maps each route word', () => {
    expect(parseRoute('general')).toBe('general');
    expect(parseRoute(' Codebase ')).toBe('codebase');
    expect(parseRoute('agentic')).toBe('agentic');
  });
  it('defaults to agentic for junk/empty', () => {
    expect(parseRoute('')).toBe('agentic');
    expect(parseRoute('I think you should build it')).toBe('agentic');
  });
});

describe('triage classifyIntent', () => {
  it('returns the classified route', async () => {
    expect(await classifyIntent(provider('general'), 'm', 'how do circuit breakers work', [])).toBe('general');
    expect(await classifyIntent(provider('codebase'), 'm', 'explain this repo', [])).toBe('codebase');
  });
  it('falls back to agentic when the call fails', async () => {
    const route = await classifyIntent(provider(() => { throw new Error('network'); }), 'm', 'x', []);
    expect(route).toBe('agentic');
  });
});
