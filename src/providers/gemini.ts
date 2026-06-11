/**
 * Google Gemini provider — native function calling + the multi-key round-robin
 * rotation that keeps Flash Code under the free-tier limits. The KeyPool holds
 * the Gemini key array; every request leases a key and reroutes on 429.
 *
 * Pure mappers exported for unit testing.
 */

import { KeyPool } from './keyPool';
import { classifyStatus, sseData, readError, safeFetch } from './http';
import {
  ChatMessage, Provider, ProviderCapabilities, StreamEvent, ToolSchema, UnifiedRequest, FinishReason,
} from './types';

const MODELS = ['gemini-2.5-flash', 'gemini-3-flash-preview', 'gemini-3.1-flash-lite', 'gemini-3.5-flash'];
const DEFAULT_MODEL = 'gemini-2.5-flash';

export function toGeminiContents(req: UnifiedRequest): any[] {
  const contents: any[] = [];
  const push = (role: 'user' | 'model', parts: any[]) => {
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };

  req.messages.forEach((m: ChatMessage, i) => {
    if (m.role === 'system') return;
    if (m.role === 'tool' && m.toolResult) {
      push('user', [{ functionResponse: { name: m.toolResult.name, response: { result: m.toolResult.content } } }]);
      return;
    }
    if (m.role === 'assistant') {
      const parts: any[] = [];
      if (m.content) parts.push({ text: m.content });
      for (const c of m.toolCalls ?? []) {
        const part: any = { functionCall: { name: c.name, args: c.arguments } };
        // Gemini 2.5/3 require the original thoughtSignature to be replayed.
        if (c.thoughtSignature) part.thoughtSignature = c.thoughtSignature;
        parts.push(part);
      }
      push('model', parts.length ? parts : [{ text: '' }]);
      return;
    }
    const parts: any[] = [{ text: m.content }];
    if (req.images?.length && i === req.messages.length - 1) {
      for (const img of req.images) {
        parts.push({ inline_data: { mime_type: img.mime || 'image/png', data: img.data.replace(/^data:[^;]+;base64,/, '') } });
      }
    }
    push('user', parts);
  });
  return contents;
}

export function toGeminiTools(tools?: ToolSchema[]): any[] | undefined {
  if (!tools?.length) return undefined;
  return [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
}

function mapFinish(reason: string | undefined): FinishReason {
  switch (reason) {
    case 'MAX_TOKENS': return 'length';
    case 'SAFETY':
    case 'RECITATION': return 'content_filter';
    default: return 'stop';
  }
}

export class GeminiProvider implements Provider {
  readonly id = 'gemini';
  readonly label = 'Google Gemini';
  readonly capabilities: ProviderCapabilities = { tools: true, vision: true, thinking: false };

  constructor(private keyPool: KeyPool, private getModel: () => string) {}

  models(): string[] { return MODELS; }
  defaultModel(): string { return DEFAULT_MODEL; }

  async *stream(req: UnifiedRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const model = req.model || this.getModel() || DEFAULT_MODEL;
    const body: any = {
      contents: toGeminiContents(req),
      systemInstruction: req.system ? { parts: [{ text: req.system }] } : undefined,
      generationConfig: { temperature: req.genConfig.temperature, maxOutputTokens: req.genConfig.maxOutputTokens },
      tools: toGeminiTools(req.tools),
    };
    yield* this.keyPool.withRotation((key) => this.doFetch(model, key, body, signal), signal);
  }

  private async *doFetch(model: string, key: string, body: any, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${key}`;
    const res = await safeFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    }, signal);
    if (!res.ok) classifyStatus(res.status, res.headers.get('retry-after'), await readError(res));

    let finish: FinishReason = 'stop';
    for await (const payload of sseData(res, signal)) {
      let j: any;
      try { j = JSON.parse(payload); } catch { continue; }
      const cand = j.candidates?.[0];
      for (const part of cand?.content?.parts ?? []) {
        if (typeof part.text === 'string') yield { type: 'text', text: part.text };
        if (part.functionCall) {
          const sig = part.thoughtSignature ?? part.thought_signature;
          yield { type: 'tool_call', call: { id: `call_${Math.random().toString(36).slice(2, 10)}`, name: part.functionCall.name, arguments: part.functionCall.args ?? {}, thoughtSignature: sig } };
        }
      }
      if (j.usageMetadata) yield { type: 'usage', inputTokens: j.usageMetadata.promptTokenCount, outputTokens: j.usageMetadata.candidatesTokenCount };
      if (cand?.finishReason) finish = mapFinish(cand.finishReason);
    }
    yield { type: 'finish', reason: finish };
  }
}
