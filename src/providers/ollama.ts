/**
 * Ollama provider — local models. Native tool-calling support varies by model,
 * so Flash Code reports `tools: false` and the agent core drives Ollama via the
 * XML tool-tag fallback (tools described in the system prompt, parsed from text).
 */

import { classifyStatus, readError, safeFetch } from './http';
import { ChatMessage, Provider, ProviderCapabilities, StreamEvent, UnifiedRequest, FinishReason } from './types';

export function toOllamaMessages(req: UnifiedRequest): any[] {
  const out: any[] = [];
  if (req.system) out.push({ role: 'system', content: req.system });
  for (const m of req.messages as ChatMessage[]) {
    if (m.role === 'system') continue;
    if (m.role === 'tool' && m.toolResult) {
      out.push({ role: 'tool', content: m.toolResult.content });
      continue;
    }
    out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
  }
  return out;
}

export interface OllamaConfig {
  url: () => string;
  model: () => string;
  numCtx: () => number;
}

export class OllamaProvider implements Provider {
  readonly id = 'ollama';
  readonly label = 'Ollama (local)';
  readonly capabilities: ProviderCapabilities = { tools: false, vision: false, thinking: false };

  constructor(private cfg: OllamaConfig) {}

  models(): string[] { return [this.cfg.model()]; }
  defaultModel(): string { return this.cfg.model(); }

  async *stream(req: UnifiedRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const url = this.cfg.url().replace(/\/$/, '') + '/api/chat';
    const res = await safeFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: req.model || this.cfg.model(),
        messages: toOllamaMessages(req),
        stream: true,
        options: { temperature: req.genConfig.temperature, num_ctx: this.cfg.numCtx(), num_predict: req.genConfig.maxOutputTokens },
      }),
      signal,
    }, signal);
    if (!res.ok) classifyStatus(res.status, null, await readError(res));

    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let finish: FinishReason = 'stop';
    for (;;) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const ln of lines) {
        const line = ln.trim();
        if (!line) continue;
        try {
          const j = JSON.parse(line);
          if (j.message?.content) yield { type: 'text', text: j.message.content };
          if (j.done) {
            finish = j.done_reason === 'length' ? 'length' : 'stop';
            // Final message carries token counts: prompt_eval_count (sent), eval_count (received).
            if (j.prompt_eval_count || j.eval_count) yield { type: 'usage', inputTokens: j.prompt_eval_count, outputTokens: j.eval_count };
          }
        } catch { /* ignore partial */ }
      }
    }
    yield { type: 'finish', reason: finish };
  }

  static async isAvailable(url: string): Promise<boolean> {
    try { return (await fetch(url.replace(/\/$/, '') + '/api/tags')).ok; } catch { return false; }
  }
}
