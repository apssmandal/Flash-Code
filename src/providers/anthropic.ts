/**
 * Anthropic Claude provider — native Messages API with tool-use, extended
 * thinking, and prompt caching on the system block. Defaults to the latest
 * Claude models.
 *
 * Pure mappers (`toAnthropicMessages`, `toAnthropicTools`) are exported for
 * unit testing without network.
 */

import { KeyPool } from './keyPool';
import { classifyStatus, sseData, readError, safeFetch } from './http';
import {
  ChatMessage, Provider, ProviderCapabilities, StreamEvent, ToolSchema, UnifiedRequest, FinishReason,
} from './types';

const MODELS = ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'];
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const API_VERSION = '2023-06-01';

export function toAnthropicTools(tools?: ToolSchema[]): any[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
}

/**
 * Convert flat ChatMessage[] into Anthropic content-block messages, merging
 * consecutive same-role turns (Anthropic requires strict alternation).
 */
export function toAnthropicMessages(req: UnifiedRequest): any[] {
  const msgs: { role: 'user' | 'assistant'; content: any[] }[] = [];
  const push = (role: 'user' | 'assistant', blocks: any[]) => {
    const last = msgs[msgs.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else msgs.push({ role, content: blocks });
  };

  req.messages.forEach((m: ChatMessage, i) => {
    if (m.role === 'system') return; // system is a top-level param
    if (m.role === 'tool' && m.toolResult) {
      push('user', [{ type: 'tool_result', tool_use_id: m.toolResult.toolCallId, content: m.toolResult.content, is_error: m.toolResult.isError }]);
      return;
    }
    if (m.role === 'assistant') {
      const blocks: any[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const c of m.toolCalls ?? []) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments });
      push('assistant', blocks.length ? blocks : [{ type: 'text', text: '' }]);
      return;
    }
    // user
    const blocks: any[] = [{ type: 'text', text: m.content }];
    if (req.images?.length && i === req.messages.length - 1) {
      for (const img of req.images) {
        blocks.push({ type: 'image', source: { type: 'base64', media_type: img.mime || 'image/png', data: img.data.replace(/^data:[^;]+;base64,/, '') } });
      }
    }
    push('user', blocks);
  });

  // Anthropic requires the first message to be from the user.
  if (msgs.length && msgs[0].role !== 'user') msgs.unshift({ role: 'user', content: [{ type: 'text', text: '(start)' }] });
  return msgs;
}

function mapStopReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'tool_use': return 'tool_use';
    case 'max_tokens': return 'length';
    case 'refusal': return 'content_filter';
    default: return 'stop';
  }
}

export class AnthropicProvider implements Provider {
  readonly id = 'anthropic';
  readonly label = 'Anthropic (Claude)';
  readonly capabilities: ProviderCapabilities = { tools: true, vision: true, thinking: true };

  constructor(private keyPool: KeyPool, private getModel: () => string) {}

  models(): string[] { return MODELS; }
  defaultModel(): string { return DEFAULT_MODEL; }

  async *stream(req: UnifiedRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const body: any = {
      model: req.model || this.getModel() || DEFAULT_MODEL,
      max_tokens: req.genConfig.maxOutputTokens,
      temperature: req.genConfig.temperature,
      stream: true,
      messages: toAnthropicMessages(req),
      tools: toAnthropicTools(req.tools),
    };
    if (req.system) {
      body.system = [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }];
    }

    yield* this.keyPool.withRotation((key) => this.doFetch(key, body, signal), signal);
  }

  private async *doFetch(key: string, body: any, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const res = await safeFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify(body),
      signal,
    }, signal);
    if (!res.ok) classifyStatus(res.status, res.headers.get('retry-after'), await readError(res));

    // Track tool_use content blocks by index to accumulate streamed JSON input.
    const toolBlocks = new Map<number, { id: string; name: string; json: string }>();
    let finish: FinishReason = 'stop';

    for await (const payload of sseData(res, signal)) {
      let j: any;
      try { j = JSON.parse(payload); } catch { continue; }
      switch (j.type) {
        case 'message_start':
          // input (prompt) tokens are reported once, up front, in message_start
          if (j.message?.usage?.input_tokens) yield { type: 'usage', inputTokens: j.message.usage.input_tokens };
          break;
        case 'content_block_start':
          if (j.content_block?.type === 'tool_use') {
            toolBlocks.set(j.index, { id: j.content_block.id, name: j.content_block.name, json: '' });
          }
          break;
        case 'content_block_delta':
          if (j.delta?.type === 'text_delta') yield { type: 'text', text: j.delta.text };
          else if (j.delta?.type === 'thinking_delta') yield { type: 'thinking', text: j.delta.thinking };
          else if (j.delta?.type === 'input_json_delta') {
            const b = toolBlocks.get(j.index);
            if (b) b.json += j.delta.partial_json;
          }
          break;
        case 'message_delta':
          if (j.delta?.stop_reason) finish = mapStopReason(j.delta.stop_reason);
          if (j.usage) yield { type: 'usage', outputTokens: j.usage.output_tokens };
          break;
        case 'message_stop':
          break;
      }
    }

    for (const b of toolBlocks.values()) {
      let input: Record<string, any> = {};
      try { input = b.json ? JSON.parse(b.json) : {}; } catch { input = {}; }
      yield { type: 'tool_call', call: { id: b.id, name: b.name, arguments: input } };
    }
    yield { type: 'finish', reason: finish };
  }
}
