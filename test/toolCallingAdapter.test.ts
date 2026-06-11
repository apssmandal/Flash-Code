import { describe, it, expect } from 'vitest';
import { ToolCallingAdapter } from '../src/core/toolCallingAdapter';
import { buildDefaultRegistry } from '../src/core/tools';
import type { Provider, StreamEvent, UnifiedRequest } from '../src/providers/types';

function provider(tools: boolean, turn: StreamEvent[]): Provider {
  return {
    id: 'p', label: 'P', capabilities: { tools, vision: false, thinking: false },
    models: () => ['m'], defaultModel: () => 'm',
    async *stream(_r: UnifiedRequest) { for (const e of turn) yield e; },
  };
}

const req = (): UnifiedRequest => ({ model: 'm', system: 'sys', messages: [{ role: 'user', content: 'hi' }], genConfig: { temperature: 0.5, maxOutputTokens: 100 } });

describe('ToolCallingAdapter', () => {
  it('native mode passes schemas and reads structured tool calls', async () => {
    const adapter = new ToolCallingAdapter(provider(true, [
      { type: 'tool_call', call: { id: 'c1', name: 'read_file', arguments: { path: 'a' } } },
      { type: 'finish', reason: 'tool_use' },
    ]), buildDefaultRegistry());
    expect(adapter.native).toBe(true);
    expect(adapter.buildSystem('sys')).toBe('sys'); // no XML block in native mode
    expect(adapter.tools()!.length).toBeGreaterThan(0);
    const turn = await adapter.runTurn(req(), () => {}, () => {});
    expect(turn.toolCalls[0].name).toBe('read_file');
    expect(turn.finish).toBe('tool_use');
  });

  it('fallback mode injects the XML tool block and parses tags from text', async () => {
    const adapter = new ToolCallingAdapter(provider(false, [
      { type: 'text', text: 'reading <read_file path="a.ts"/> now' },
      { type: 'finish', reason: 'stop' },
    ]), buildDefaultRegistry());
    expect(adapter.native).toBe(false);
    const sys = adapter.buildSystem('sys');
    expect(sys).toContain('<tools>');
    expect(adapter.tools()).toBeUndefined();
    const turn = await adapter.runTurn(req(), () => {}, () => {});
    expect(turn.toolCalls[0].name).toBe('read_file');
    expect(turn.toolCalls[0].arguments.path).toBe('a.ts');
    expect(turn.text).not.toContain('read_file'); // stripped from display prose
  });

  it('flags truncation of an unclosed body tag in fallback mode', async () => {
    const adapter = new ToolCallingAdapter(provider(false, [
      { type: 'text', text: '<edit path="a">partial' },
      { type: 'finish', reason: 'stop' },
    ]), buildDefaultRegistry());
    const turn = await adapter.runTurn(req(), () => {}, () => {});
    expect(turn.truncated).toBe(true);
  });
});
