import { describe, it, expect } from 'vitest';
import { toOpenAIMessages, toOpenAITools, OpenAIStreamParser } from '../src/providers/openaiCompatible';
import { toAnthropicMessages, toAnthropicTools } from '../src/providers/anthropic';
import { toGeminiContents, toGeminiTools } from '../src/providers/gemini';
import type { UnifiedRequest, StreamEvent } from '../src/providers/types';

const base: UnifiedRequest = {
  model: 'm',
  system: 'You are Flash Code.',
  genConfig: { temperature: 0.5, maxOutputTokens: 1000 },
  messages: [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'using a tool', toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a.ts' } }] },
    { role: 'tool', content: '', toolResult: { toolCallId: 'c1', name: 'read_file', content: 'file body' } },
  ],
  tools: [{ name: 'read_file', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
};

describe('OpenAI-compatible mappers', () => {
  it('maps system, tool-call, and tool-result turns', () => {
    const msgs = toOpenAIMessages(base);
    expect(msgs[0]).toEqual({ role: 'system', content: 'You are Flash Code.' });
    const asst = msgs.find((m) => m.role === 'assistant');
    expect(asst.tool_calls[0].function.name).toBe('read_file');
    expect(JSON.parse(asst.tool_calls[0].function.arguments)).toEqual({ path: 'a.ts' });
    const tool = msgs.find((m) => m.role === 'tool');
    expect(tool).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'file body' });
  });

  it('maps tools to function schema', () => {
    const tools = toOpenAITools(base.tools)!;
    expect(tools[0].type).toBe('function');
    expect(tools[0].function.name).toBe('read_file');
  });

  it('accumulates streamed tool-call deltas and flushes on finish', () => {
    const p = new OpenAIStreamParser();
    const events: StreamEvent[] = [];
    events.push(...p.parse(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c9', function: { name: 'edit', arguments: '{"path":' } }] } }] })));
    events.push(...p.parse(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x.ts"}' } }] } }] })));
    events.push(...p.parse(JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })));
    events.push(...p.flush());
    const call = events.find((e) => e.type === 'tool_call') as any;
    expect(call.call.name).toBe('edit');
    expect(call.call.arguments).toEqual({ path: 'x.ts' });
    expect(events.some((e) => e.type === 'finish' && e.reason === 'tool_use')).toBe(true);
  });
});

describe('Anthropic mappers', () => {
  it('produces content blocks with tool_use and tool_result, user-first', () => {
    const msgs = toAnthropicMessages(base);
    expect(msgs[0].role).toBe('user');
    const asst = msgs.find((m) => m.role === 'assistant');
    expect(asst.content.some((b: any) => b.type === 'tool_use' && b.name === 'read_file')).toBe(true);
    const userWithResult = msgs.find((m) => m.role === 'user' && m.content.some((b: any) => b.type === 'tool_result'));
    expect(userWithResult).toBeTruthy();
  });

  it('maps tools to input_schema', () => {
    const tools = toAnthropicTools(base.tools)!;
    expect(tools[0].input_schema.properties.path.type).toBe('string');
  });
});

describe('Gemini mappers', () => {
  it('maps to contents with functionCall and functionResponse parts', () => {
    const contents = toGeminiContents(base);
    const model = contents.find((c) => c.role === 'model');
    expect(model.parts.some((p: any) => p.functionCall?.name === 'read_file')).toBe(true);
    const user = contents.find((c) => c.parts.some((p: any) => p.functionResponse));
    expect(user).toBeTruthy();
  });

  it('wraps tools in functionDeclarations', () => {
    const tools = toGeminiTools(base.tools)!;
    expect(tools[0].functionDeclarations[0].name).toBe('read_file');
  });

  it('replays a thoughtSignature on the functionCall part (Gemini 2.5/3 requirement)', () => {
    const req: UnifiedRequest = {
      ...base,
      messages: [
        { role: 'user', content: 'read it' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a' }, thoughtSignature: 'SIG123' }] },
        { role: 'tool', content: '', toolResult: { toolCallId: 'c1', name: 'read_file', content: 'body' } },
      ],
    };
    const contents = toGeminiContents(req);
    const model = contents.find((c) => c.role === 'model');
    const fcPart = model.parts.find((p: any) => p.functionCall);
    expect(fcPart.thoughtSignature).toBe('SIG123');
  });
});
