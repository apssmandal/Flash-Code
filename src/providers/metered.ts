/**
 * Metering proxy around a Provider. Wraps `stream()` to observe the `usage`
 * StreamEvents that providers already emit and reports the token totals for the
 * completed call via `onCall` — exactly once per `stream()` invocation.
 *
 * Providers report usage differently: Gemini emits CUMULATIVE `usageMetadata`
 * on every chunk, OpenAI emits one usage block at the end, Anthropic emits
 * input (message_start) and output (message_delta) separately. So we never sum
 * usage events — we keep the latest/most-complete non-undefined value for each
 * of input/output and report once when the stream finishes (or aborts/throws).
 */

import type { Provider, StreamEvent, UnifiedRequest } from './types';

export type UsageSink = (provider: string, model: string, inputTokens: number, outputTokens: number) => void;

export function meterProvider(inner: Provider, onCall: UsageSink): Provider {
  return {
    id: inner.id,
    label: inner.label,
    capabilities: inner.capabilities,
    models: () => inner.models(),
    defaultModel: () => inner.defaultModel(),
    async *stream(req: UnifiedRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
      let input = 0;
      let output = 0;
      let saw = false;
      try {
        for await (const ev of inner.stream(req, signal)) {
          if (ev.type === 'usage') {
            if (typeof ev.inputTokens === 'number') { input = ev.inputTokens; saw = true; }
            if (typeof ev.outputTokens === 'number') { output = ev.outputTokens; saw = true; }
          }
          yield ev;
        }
      } finally {
        // Record even on abort/throw so partial spend is still counted.
        if (saw) onCall(inner.id, req.model, input, output);
      }
    },
  };
}
