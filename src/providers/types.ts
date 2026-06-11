/**
 * The provider abstraction — the single seam that makes Flash Code multi-model.
 *
 * Every provider maps its wire format to/from these canonical types and emits a
 * normalized `StreamEvent` stream. The agent loop (core/agentLoop) consumes only
 * these types, so it never knows or cares which backend produced them. Adding a
 * provider = implement `Provider` + register it.
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

/** A JSON-Schema fragment describing a tool's parameters. */
export interface JSONSchema {
  type: 'object';
  properties: Record<string, any>;
  required?: string[];
  [k: string]: any;
}

/** A tool the model may call, expressed once and translated per provider. */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: JSONSchema;
}

/** A tool invocation requested by the model. */
export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: Record<string, any>;
  /** Provider-specific opaque token that must be echoed back in history.
   * Gemini 2.5/3 attach a `thoughtSignature` to function calls and reject the
   * follow-up request if it isn't replayed. Ignored by other providers. */
  thoughtSignature?: string;
}

/** The result of executing a tool, fed back to the model. */
export interface ToolResultMessage {
  toolCallId: string;
  name: string;
  content: string;
  isError?: boolean;
}

export interface ChatMessage {
  role: Role;
  content: string;
  /** assistant turns that requested tools */
  toolCalls?: ToolCallRequest[];
  /** tool-result turns */
  toolResult?: ToolResultMessage;
}

export interface GenConfig {
  temperature: number;
  maxOutputTokens: number;
  topP?: number;
}

export interface ImageInput {
  mime: string;
  /** base64 (with or without data: prefix) */
  data: string;
}

export interface ProviderCapabilities {
  /** native function/tool calling — when false, the agent uses the XML fallback */
  tools: boolean;
  vision: boolean;
  /** exposes a reasoning/thinking stream */
  thinking: boolean;
}

export interface UnifiedRequest {
  model: string;
  system?: string;
  messages: ChatMessage[];
  tools?: ToolSchema[];
  genConfig: GenConfig;
  images?: ImageInput[];
}

export type FinishReason = 'stop' | 'length' | 'tool_use' | 'content_filter' | 'error';

/** The normalized streaming event union every provider yields. */
export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; call: ToolCallRequest }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number }
  | { type: 'finish'; reason: FinishReason };

export interface Provider {
  readonly id: string;
  readonly label: string;
  readonly capabilities: ProviderCapabilities;
  /** Known model ids for the picker (may be a curated subset). */
  models(): string[];
  /** The default model id if config is unset. */
  defaultModel(): string;
  /** Stream a completion. Implementations must honor `signal`. */
  stream(req: UnifiedRequest, signal?: AbortSignal): AsyncIterable<StreamEvent>;
}

export const EFFORT: Record<string, GenConfig> = {
  low: { maxOutputTokens: 8192, temperature: 0.4 },
  medium: { maxOutputTokens: 16384, temperature: 0.6 },
  high: { maxOutputTokens: 32768, temperature: 0.7 },
  xhigh: { maxOutputTokens: 64000, temperature: 0.85 },
  max: { maxOutputTokens: 64000, temperature: 1.0 },
};
