/**
 * The provider-agnostic agent loop. Streams a turn, executes the requested
 * tools (honoring mode-gating, the plan-mode mutation ban, and the
 * spawn-blocking rule), feeds results back, and repeats until the model stops
 * or the iteration cap is hit. Works identically for native tool-use and the
 * XML fallback via ToolCallingAdapter.
 */

import type { Provider, ChatMessage, GenConfig, ToolCallRequest } from '../providers/types';
import type { ToolContext } from './toolContext';
import { ToolRegistry } from './toolRegistry';
import { ToolCallingAdapter } from './toolCallingAdapter';
import { isAbort } from './errors';
import { createLogger } from './logger';
import { COMPLETION_JUDGE } from '../prompts/system';

const log = createLogger('agentLoop');

export interface AgentLoopConfig {
  provider: Provider;
  registry: ToolRegistry;
  ctx: ToolContext;
  systemPrompt: string;
  model: string;
  genConfig: GenConfig;
  allowedTools?: string[];
  maxIterations?: number;
  /** When true, a cheap judge verifies the objective is met before stopping. */
  verifyCompletion?: boolean;
}

const TASK_LIST_RE = /<task_list>([\s\S]*?)<\/task_list>/;

export class AgentLoop {
  private adapter: ToolCallingAdapter;
  private cancelled = false;
  /** signatures of read-only calls already executed this run (for dedup) */
  private seen = new Set<string>();
  /** consecutive turns that produced no new information */
  private stall = 0;

  constructor(private cfg: AgentLoopConfig) {
    this.adapter = new ToolCallingAdapter(cfg.provider, cfg.registry, cfg.allowedTools);
  }

  cancel() { this.cancelled = true; }

  async run(userText: string, history: ChatMessage[], signal?: AbortSignal): Promise<string> {
    const { ctx } = this.cfg;
    const system = this.adapter.buildSystem(this.cfg.systemPrompt);
    const messages: ChatMessage[] = [...history.slice(-8), { role: 'user', content: userText }];
    const max = this.cfg.maxIterations ?? 50;
    let finalProse = '';
    // Completion gate: how many times we may push the model to keep going after
    // it tries to stop prematurely. Bounded so it can never loop forever.
    const maxContinuations = this.cfg.verifyCompletion ? 3 : 0;
    let continuations = 0;

    try {
      for (let iter = 0; iter < max; iter++) {
        if (this.cancelled || signal?.aborted) { ctx.emit({ type: 'status', text: 'Stopped.' }); break; }
        ctx.emit({ type: 'status', text: 'Thinking…' });

        const turn = await this.adapter.runTurn(
          { model: this.cfg.model, system, messages, tools: this.adapter.tools(), genConfig: this.cfg.genConfig },
          (full) => ctx.emit({ type: 'prose', text: full }),
          (t) => ctx.emit({ type: 'thinking', text: t }),
          signal,
        );

        emitTaskList(turn.text + turn.thinking, ctx);

        // Record the assistant turn (with tool calls for native correlation).
        messages.push({ role: 'assistant', content: turn.text, toolCalls: turn.toolCalls.length ? turn.toolCalls : undefined });

        if (turn.truncated) {
          messages.push({ role: 'user', content: '[SYSTEM] Your last response was cut off before a closing tag. Continue and close the tag.' });
          continue;
        }
        if (turn.text.trim()) { ctx.emit({ type: 'prose', text: turn.text.trim() }); finalProse = turn.text.trim(); }

        if (!turn.toolCalls.length) {
          if (turn.finish === 'length') {
            messages.push({ role: 'user', content: '[SYSTEM] You hit the output limit. Continue exactly where you left off.' });
            continue;
          }
          // Completion gate: don't stop on a mere intention ("let me check…").
          if (continuations < maxContinuations && !(await this.isComplete(userText, finalProse, signal))) {
            continuations++;
            ctx.emit({ type: 'status', text: 'Checking the objective is complete…' });
            messages.push({ role: 'user', content: '[SYSTEM] The objective is NOT yet complete — you stopped with unfinished work or only an intention. Continue now: do the remaining work (read/edit/run as needed) and only finish once the request is fully satisfied with a complete, conclusive final answer.' });
            continue;
          }
          break; // genuinely done
        }

        const progressed = await this.executeTools(turn.toolCalls, messages, signal);

        // No-progress guard: if a turn only repeated calls we've already run,
        // nudge once, then force a final answer — this kills list_files loops.
        if (!progressed) {
          this.stall++;
          if (this.stall === 1) {
            messages.push({ role: 'user', content: '[SYSTEM] You already have this information — repeating tool calls returns nothing new. Stop calling tools and give your final answer now.' });
          } else {
            ctx.emit({ type: 'status', text: 'Wrapping up…' });
            const last = await this.adapter.runTurn(
              { model: this.cfg.model, system, messages: [...messages, { role: 'user', content: '[SYSTEM] Provide your final answer now using what you already know. Do NOT call any tools.' }], tools: undefined, genConfig: this.cfg.genConfig },
              (full) => ctx.emit({ type: 'prose', text: full }), () => {}, signal,
            );
            if (last.text.trim()) { ctx.emit({ type: 'prose', text: last.text.trim() }); finalProse = last.text.trim(); }
            break;
          }
        } else {
          this.stall = 0;
        }
      }
    } catch (e: any) {
      if (!isAbort(e)) { log.error(e?.message); ctx.emit({ type: 'error', message: e?.message ?? String(e) }); }
    }
    ctx.emit({ type: 'done' });
    return finalProse;
  }

  /** Returns true if at least one tool produced new information this turn. */
  private async executeTools(calls: ToolCallRequest[], messages: ChatMessage[], signal?: AbortSignal): Promise<boolean> {
    const { ctx, registry } = this.cfg;
    const native = this.adapter.native;
    const xmlResults: string[] = [];
    let spawned = false;
    let progressed = false;

    for (const call of calls) {
      if (this.cancelled || signal?.aborted) break;
      const def = registry.get(call.name);
      let result: string;

      const sig = `${call.name}:${stableArgs(call.arguments)}`;
      const isReadOnly = def && !def.mutates && def.category === 'read';

      if (!def) {
        result = `[${call.name}] ERROR: unknown tool.`;
      } else if (spawned && def.category !== 'control') {
        result = `[${call.name}] IGNORED: you spawned an agent this turn; wait for its result before issuing more tools.`;
      } else if (isReadOnly && this.seen.has(sig)) {
        // Duplicate read — don't re-run; tell the model the result is unchanged.
        result = `[${call.name}] Already executed earlier with identical arguments; the result is unchanged. Do NOT repeat it — use the previous result, or give your final answer now.`;
        ctx.emit({ type: 'tool_start', id: call.id, tool: call.name, detail: detailOf(call) });
        ctx.emit({ type: 'tool_result', id: call.id, tool: call.name, ok: true, summary: '(already retrieved — skipped)' });
      } else if (!this.planGate(def.mutates, def.planAllowed, call)) {
        result = `[${call.name}] ERROR: mutations are forbidden in plan mode. You may only write .md / .flash plan files.`;
      } else {
        const id = call.id;
        ctx.emit({ type: 'tool_start', id, tool: call.name, detail: detailOf(call) });
        try {
          result = await def.handler(call.arguments, ctx, signal);
          ctx.emit({ type: 'tool_result', id, tool: call.name, ok: true, summary: toolPreview(result) });
          if (isReadOnly) this.seen.add(sig);
          progressed = true;
        } catch (e: any) {
          result = `[${call.name}] ERROR: ${e?.message ?? String(e)}`;
          ctx.emit({ type: 'tool_result', id, tool: call.name, ok: false, summary: e?.message ?? 'failed' });
        }
        if (call.name === 'spawn_agent') spawned = true;
      }

      if (native) {
        messages.push({ role: 'tool', content: '', toolResult: { toolCallId: call.id, name: call.name, content: result } });
      } else {
        xmlResults.push(result);
      }
    }

    if (!native && xmlResults.length) {
      messages.push({ role: 'user', content: '[tool results]\n' + xmlResults.join('\n\n') });
    }
    return progressed;
  }

  /** Strict cheap judge: is the user's request fully satisfied? Defaults to
   * "complete" on any failure so it can never block or loop forever. */
  private async isComplete(userText: string, finalProse: string, signal?: AbortSignal): Promise<boolean> {
    try {
      let out = '';
      for await (const ev of this.cfg.provider.stream(
        {
          model: this.cfg.model,
          system: COMPLETION_JUDGE,
          messages: [{ role: 'user', content: `Request:\n${userText}\n\nAssistant's latest message:\n${finalProse || '(no answer produced)'}` }],
          genConfig: { temperature: 0, maxOutputTokens: 8 },
        },
        signal,
      )) {
        if (ev.type === 'text') out += ev.text;
      }
      // Default to done unless the judge clearly says CONTINUE.
      return !/\bcontinue\b/i.test(out);
    } catch (e: any) {
      log.warn(`completion judge failed (${e?.message}) — accepting stop`);
      return true;
    }
  }

  /** Allow non-mutating tools always; mutations only for .md/.flash files in plan mode. */
  private planGate(mutates: boolean, planAllowed: boolean | undefined, call: ToolCallRequest): boolean {
    if (this.cfg.ctx.mode() !== 'plan') return true;
    if (!mutates) return true;
    if (planAllowed) return true;
    const path: string = call.arguments?.path ?? '';
    return /\.md$/.test(path) || path.includes('.flash/');
  }
}

/** Stable stringification of args (sorted keys) so dedup is order-independent. */
function stableArgs(args: Record<string, any> | undefined): string {
  if (!args) return '';
  try { return JSON.stringify(args, Object.keys(args).sort()); } catch { return String(args); }
}

function detailOf(call: ToolCallRequest): string {
  const a = call.arguments || {};
  return String(a.path || a.command || a.pattern || a.query || a.url || a.task || a.role || '');
}

/** Tool handlers prefix their result with a "[tool args]" label line; strip it
 * and show the real output (truncated) in the tool card. */
function toolPreview(s: string): string {
  const body = s.replace(/^\[[^\]\n]*\][ \t]*\n?/, '').trim();
  const text = body || s.trim();
  return text.length > 1500 ? text.slice(0, 1500) + '\n…(truncated)' : text;
}

function emitTaskList(buf: string, ctx: ToolContext): void {
  const m = TASK_LIST_RE.exec(buf);
  if (!m) return;
  try { ctx.emit({ type: 'tasks', tasks: JSON.parse(m[1].trim()) }); } catch { /* ignore */ }
}
