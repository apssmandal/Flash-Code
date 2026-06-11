/**
 * OpenAI-compatible provider. One implementation backs OpenAI, OpenRouter,
 * Groq, DeepSeek, and Nvidia — they differ only by base URL, model, and key.
 *
 * Pure mapping functions (`toOpenAIMessages`, `toOpenAITools`, `parseSSEChunk`)
 * are exported separately so provider behavior is unit-testable without network.
 */

import { KeyPool } from './keyPool';
import { classifyStatus, sseData, readError, safeFetch } from './http';
import {
  ChatMessage, Provider, ProviderCapabilities, StreamEvent, ToolCallRequest, ToolSchema, UnifiedRequest, FinishReason,
} from './types';

export function toOpenAITools(tools?: ToolSchema[]): any[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

export function toOpenAIMessages(req: UnifiedRequest): any[] {
  const out: any[] = [];
  if (req.system) out.push({ role: 'system', content: req.system });
  req.messages.forEach((m: ChatMessage, i) => {
    if (m.role === 'tool' && m.toolResult) {
      out.push({ role: 'tool', tool_call_id: m.toolResult.toolCallId, content: m.toolResult.content });
      return;
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      out.push({
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } })),
      });
      return;
    }
    // Attach images to the final user message when present.
    if (m.role === 'user' && req.images?.length && i === req.messages.length - 1) {
      const parts: any[] = [{ type: 'text', text: m.content }];
      for (const img of req.images) {
        const url = img.data.startsWith('data:') ? img.data : `data:${img.mime};base64,${img.data}`;
        parts.push({ type: 'image_url', image_url: { url } });
      }
      out.push({ role: 'user', content: parts });
      return;
    }
    out.push({ role: m.role, content: m.content });
  });
  return out;
}

function mapFinish(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'tool_calls': return 'tool_use';
    case 'length': return 'length';
    case 'content_filter': return 'content_filter';
    default: return 'stop';
  }
}

interface ToolAccum { id: string; name: string; args: string; }

/** Stateful SSE chunk parser; accumulates tool-call deltas across events. */
export class OpenAIStreamParser {
  private toolAccum = new Map<number, ToolAccum>();
  private finish: FinishReason | null = null;

  parse(payload: string): StreamEvent[] {
    if (payload === '[DONE]') return this.flush();
    let j: any;
    try { j = JSON.parse(payload); } catch { return []; }
    const choice = j.choices?.[0];
    const delta = choice?.delta;
    const events: StreamEvent[] = [];
    if (delta?.reasoning_content) events.push({ type: 'thinking', text: delta.reasoning_content });
    if (delta?.content) events.push({ type: 'text', text: delta.content });
    if (Array.isArray(delta?.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        const acc = this.toolAccum.get(idx) ?? { id: '', name: '', args: '' };
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name = tc.function.name;
        if (tc.function?.arguments) acc.args += tc.function.arguments;
        this.toolAccum.set(idx, acc);
      }
    }
    if (choice?.finish_reason) this.finish = mapFinish(choice.finish_reason);
    if (j.usage) events.push({ type: 'usage', inputTokens: j.usage.prompt_tokens, outputTokens: j.usage.completion_tokens });
    return events;
  }

  /** Emit accumulated tool calls + the finish event at stream end. */
  flush(): StreamEvent[] {
    const events: StreamEvent[] = [];
    for (const acc of this.toolAccum.values()) {
      if (!acc.name) continue;
      events.push({ type: 'tool_call', call: parseToolCall(acc.id, acc.name, acc.args) });
    }
    this.toolAccum.clear();
    events.push({ type: 'finish', reason: this.finish ?? 'stop' });
    this.finish = null;
    return events;
  }
}

function parseToolCall(id: string, name: string, args: string): ToolCallRequest {
  let parsed: Record<string, any> = {};
  try { parsed = args ? JSON.parse(args) : {}; } catch { parsed = { _raw: args }; }
  return { id: id || `call_${Math.random().toString(36).slice(2, 10)}`, name, arguments: parsed };
}

export interface OpenAICompatConfig {
  id: string;
  label: string;
  baseUrl: () => string;
  model: () => string;
  defaultModel: string;
  models: string[];
  keyPool: KeyPool;
  capabilities?: Partial<ProviderCapabilities>;
  /** extra headers (e.g. OpenRouter referer) */
  headers?: () => Record<string, string>;
}

export class OpenAICompatibleProvider implements Provider {
  readonly id: string;
  readonly label: string;
  readonly capabilities: ProviderCapabilities;

  constructor(private cfg: OpenAICompatConfig) {
    this.id = cfg.id;
    this.label = cfg.label;
    this.capabilities = { tools: true, vision: true, thinking: false, ...cfg.capabilities };
  }

  models(): string[] { return this.cfg.models; }
  defaultModel(): string { return this.cfg.defaultModel; }

  async *stream(req: UnifiedRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const body = {
      model: req.model || this.cfg.model() || this.cfg.defaultModel,
      messages: toOpenAIMessages(req),
      tools: toOpenAITools(req.tools),
      temperature: req.genConfig.temperature,
      max_tokens: req.genConfig.maxOutputTokens,
      top_p: req.genConfig.topP ?? 0.95,
      stream: true,
      stream_options: { include_usage: true },
    };
    const url = this.cfg.baseUrl().replace(/\/$/, '') + '/chat/completions';

    yield* this.cfg.keyPool.withRotation((key) =>
      this.doFetch(url, key, body, signal), signal);
  }

  private async *doFetch(url: string, key: string, body: any, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const res = await safeFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, ...(this.cfg.headers?.() ?? {}) },
      body: JSON.stringify(body),
      signal,
    }, signal);
    if (!res.ok) classifyStatus(res.status, res.headers.get('retry-after'), await readError(res));

    const parser = new OpenAIStreamParser();
    let sawDone = false;
    for await (const payload of sseData(res, signal)) {
      if (payload === '[DONE]') { sawDone = true; for (const e of parser.flush()) yield e; break; }
      for (const e of parser.parse(payload)) yield e;
    }
    if (!sawDone) for (const e of parser.flush()) yield e;
  }
}
