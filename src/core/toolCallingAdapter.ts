/**
 * Normalizes the two tool transports into one shape for the agent loop:
 *   - native: pass JSON tool schemas, read structured tool_call events
 *   - fallback: inject an XML tool block into the system prompt, parse tags from text
 * Either way the loop receives { text, thinking, toolCalls, finish }.
 */

import type { Provider, StreamEvent, ToolCallRequest, ToolSchema, UnifiedRequest, FinishReason } from '../providers/types';
import type { ToolRegistry } from './toolRegistry';
import { parseXmlToolCalls, isTruncated } from './xmlToolParser';

export const XML_TOOL_INSTRUCTIONS = `
You do not have native tool calling. To use a tool, emit its XML tag as RAW, UNESCAPED XML (never inside a markdown code fence). Self-closing tools take attributes; body tools wrap content:
  <read_file path="src/x.ts"/>
  <edit path="src/x.ts"><<<<<<< SEARCH
old
=======
new
>>>>>>> REPLACE
</edit>
Emit all independent tool calls in one turn. After tool results return, continue. When finished, reply with prose only and no tags.`;

export interface NormalizedTurn {
  text: string;
  thinking: string;
  toolCalls: ToolCallRequest[];
  finish: FinishReason;
  truncated: boolean;
}

export class ToolCallingAdapter {
  constructor(private provider: Provider, private registry: ToolRegistry, private allowed?: string[]) {}

  get native(): boolean { return this.provider.capabilities.tools; }

  /** Build the system prompt; XML mode appends the tool block + instructions. */
  buildSystem(base: string): string {
    if (this.native) return base;
    return `${base}\n\n<tools>\n${this.registry.xmlDefinitions(this.allowed)}\n</tools>\n${XML_TOOL_INSTRUCTIONS}`;
  }

  tools(): ToolSchema[] | undefined {
    return this.native ? this.registry.schemas(this.allowed) : undefined;
  }

  /** Stream one turn, emitting text/thinking deltas via callbacks, and normalize. */
  async runTurn(
    req: UnifiedRequest,
    onText: (full: string) => void,
    onThinking: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<NormalizedTurn> {
    let text = '';
    let thinking = '';
    const nativeCalls: ToolCallRequest[] = [];
    let finish: FinishReason = 'stop';

    for await (const ev of this.provider.stream(req, signal) as AsyncIterable<StreamEvent>) {
      switch (ev.type) {
        case 'text': text += ev.text; onText(this.native ? text : stripForDisplay(text)); break;
        case 'thinking': thinking += ev.text; onThinking(ev.text); break;
        case 'tool_call': nativeCalls.push(ev.call); break;
        case 'finish': finish = ev.reason; break;
        case 'usage': break;
      }
    }

    if (this.native) {
      return { text, thinking, toolCalls: nativeCalls, finish, truncated: false };
    }
    if (isTruncated(text)) {
      return { text, thinking, toolCalls: [], finish, truncated: true };
    }
    const names = this.registry.list().map((t) => t.name);
    const { calls, prose } = parseXmlToolCalls(text, names);
    return { text: prose, thinking, toolCalls: calls, finish, truncated: false };
  }
}

/** Strip tool tags from streaming XML-mode text so the UI shows clean prose. */
function stripForDisplay(s: string): string {
  return s
    .replace(/<think\b[^>]*>[\s\S]*?(<\/think>|$)/g, '')
    .replace(/<thought\b[^>]*>[\s\S]*?(<\/thought>|$)/g, '')
    .replace(/<(edit|create|overwrite_file|append_file|run_code|ask_user)\b[^>]*>[\s\S]*?(<\/\1>|$)/g, '')
    .replace(/<[a-z_]+\b[^>]*\/?>/g, '')
    .trim();
}
