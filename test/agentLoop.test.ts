import { describe, it, expect } from 'vitest';
import { AgentLoop } from '../src/core/agentLoop';
import { buildDefaultRegistry } from '../src/core/tools';
import type { Provider, StreamEvent, UnifiedRequest } from '../src/providers/types';
import type { ToolContext } from '../src/core/toolContext';
import type { AgentEvent, AgentMode } from '../src/core/events';

/** Scripted provider: each call to stream() yields the next pre-baked turn. */
function scriptedProvider(turns: StreamEvent[][], tools: boolean): Provider {
  let i = 0;
  return {
    id: 'fake', label: 'Fake', capabilities: { tools, vision: false, thinking: false },
    models: () => ['m'], defaultModel: () => 'm',
    async *stream(_req: UnifiedRequest): AsyncIterable<StreamEvent> {
      const turn = turns[Math.min(i, turns.length - 1)];
      i++;
      for (const ev of turn) yield ev;
    },
  };
}

function fakeCtx(overrides: Partial<ToolContext> = {}): { ctx: ToolContext; events: AgentEvent[]; writes: Record<string, string> } {
  const events: AgentEvent[] = [];
  const writes: Record<string, string> = {};
  const files: Record<string, string> = { 'src/a.ts': 'export const a = 1;' };
  const ctx: ToolContext = {
    readFile: async (p) => { if (p in files) return files[p]; throw new Error('not found'); },
    writeFile: async (p, c) => { writes[p] = c; files[p] = c; },
    fileExists: async (p) => p in files,
    deleteFile: async (p) => { delete files[p]; },
    renameFile: async () => {}, copyFile: async () => {},
    listDir: async () => [], createDir: async () => {},
    stat: async () => ({ size: 1, mtime: 0 }),
    projectTree: async () => 'src/\n  a.ts',
    allFiles: async () => Object.keys(files),
    workspaceRoot: () => '/ws',
    runCommand: async (_c, onOut) => { onOut('ran'); return { code: 0, output: 'ran' }; },
    runExec: async (_f, _a, onOut) => { onOut('ok'); return { code: 0, output: 'ok' }; },
    fetchText: async () => 'web',
    mode: () => 'autonomous' as AgentMode,
    emit: (e) => events.push(e),
    askApproval: async () => true,
    askUser: async () => 'yes',
    presentDiff: async (p, _o, n) => { writes[p] = n; files[p] = n; return true; },
    recordSnapshot: () => {},
    spawn: async () => 'subagent done',
    ...overrides,
  };
  return { ctx, events, writes };
}

const text = (t: string): StreamEvent => ({ type: 'text', text: t });
const finish = (reason: any): StreamEvent => ({ type: 'finish', reason });

describe('AgentLoop — native tool-use', () => {
  it('executes a native tool_call, feeds the result back, and returns final prose', async () => {
    const provider = scriptedProvider([
      [{ type: 'tool_call', call: { id: 'c1', name: 'read_file', arguments: { path: 'src/a.ts' } } }, finish('tool_use')],
      [text('The file defines a constant.'), finish('stop')],
    ], true);
    const { ctx, events } = fakeCtx();
    const loop = new AgentLoop({ provider, registry: buildDefaultRegistry(), ctx, systemPrompt: 'sys', model: 'm', genConfig: { temperature: 0.5, maxOutputTokens: 100 } });
    const result = await loop.run('explain a.ts', []);
    expect(result).toBe('The file defines a constant.');
    expect(events.some((e) => e.type === 'tool_start' && e.tool === 'read_file')).toBe(true);
    expect(events.some((e) => e.type === 'tool_result' && e.ok)).toBe(true);
    // The tool card output must be the real content, not the "[read_file …]" label echo.
    const tr = events.find((e) => e.type === 'tool_result') as any;
    expect(tr.summary).toContain('export const a = 1;');
    expect(tr.summary).not.toMatch(/^\[read_file/);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('applies an edit via presentDiff', async () => {
    const provider = scriptedProvider([
      [{ type: 'tool_call', call: { id: 'c1', name: 'edit', arguments: { path: 'src/a.ts', _body: '<<<<<<< SEARCH\nexport const a = 1;\n=======\nexport const a = 2;\n>>>>>>> REPLACE' } } }, finish('tool_use')],
      [text('Updated.'), finish('stop')],
    ], true);
    const { ctx, writes } = fakeCtx();
    const loop = new AgentLoop({ provider, registry: buildDefaultRegistry(), ctx, systemPrompt: 'sys', model: 'm', genConfig: { temperature: 0.5, maxOutputTokens: 100 } });
    await loop.run('bump a', []);
    expect(writes['src/a.ts']).toContain('export const a = 2;');
  });
});

describe('AgentLoop — XML fallback', () => {
  it('parses an XML tool tag from text and executes it', async () => {
    const provider = scriptedProvider([
      [text('Let me read it. <read_file path="src/a.ts"/>'), finish('stop')],
      [text('Done reading.'), finish('stop')],
    ], false);
    const { ctx, events } = fakeCtx();
    const loop = new AgentLoop({ provider, registry: buildDefaultRegistry(), ctx, systemPrompt: 'sys', model: 'm', genConfig: { temperature: 0.5, maxOutputTokens: 100 } });
    const result = await loop.run('read a', []);
    expect(events.some((e) => e.type === 'tool_start' && e.tool === 'read_file')).toBe(true);
    expect(result).toBe('Done reading.');
  });
});

describe('AgentLoop — dedup / no-progress guard', () => {
  it('short-circuits a repeated identical read-only call and converges', async () => {
    const provider = scriptedProvider([
      [{ type: 'tool_call', call: { id: 'a', name: 'list_files', arguments: {} } }, finish('tool_use')],
      [{ type: 'tool_call', call: { id: 'b', name: 'list_files', arguments: {} } }, finish('tool_use')],
      [text('The project has a few files.'), finish('stop')],
    ], true);
    let treeCalls = 0;
    const { ctx } = fakeCtx({ projectTree: async () => { treeCalls++; return 'src/\n  a.ts'; } });
    const loop = new AgentLoop({ provider, registry: buildDefaultRegistry(), ctx, systemPrompt: 'sys', model: 'm', genConfig: { temperature: 0.5, maxOutputTokens: 100 }, maxIterations: 12 });
    const result = await loop.run('what files exist', []);
    expect(treeCalls).toBe(1); // second list_files was deduped, not re-run
    expect(result).toBe('The project has a few files.');
  });
});

/** Provider that answers completion-judge calls separately from agent turns. */
function gatedProvider(agentTurns: StreamEvent[][], verdicts: string[]): Provider {
  let ai = 0, ji = 0;
  return {
    id: 'fake', label: 'Fake', capabilities: { tools: true, vision: false, thinking: false },
    models: () => ['m'], defaultModel: () => 'm',
    async *stream(req: UnifiedRequest): AsyncIterable<StreamEvent> {
      if (req.system && req.system.includes('task-completion judge')) {
        yield { type: 'text', text: verdicts[Math.min(ji++, verdicts.length - 1)] };
        yield finish('stop');
        return;
      }
      for (const ev of agentTurns[Math.min(ai++, agentTurns.length - 1)]) yield ev;
    },
  };
}

describe('AgentLoop — completion gate', () => {
  it('does not stop on a mere intention; continues until the judge says DONE', async () => {
    const provider = gatedProvider(
      [[text('Let me check package.json.'), finish('stop')], [text('This is a todo app built with Vite.'), finish('stop')]],
      ['CONTINUE', 'DONE'],
    );
    const { ctx } = fakeCtx();
    const loop = new AgentLoop({ provider, registry: buildDefaultRegistry(), ctx, systemPrompt: 'sys', model: 'm', genConfig: { temperature: 0.5, maxOutputTokens: 100 }, verifyCompletion: true, maxIterations: 12 });
    const result = await loop.run('explain this codebase', []);
    expect(result).toBe('This is a todo app built with Vite.');
  });

  it('terminates even if the judge always says CONTINUE (no infinite loop)', async () => {
    const provider = gatedProvider([[text('still working...'), finish('stop')]], ['CONTINUE']);
    const { ctx } = fakeCtx();
    const loop = new AgentLoop({ provider, registry: buildDefaultRegistry(), ctx, systemPrompt: 'sys', model: 'm', genConfig: { temperature: 0.5, maxOutputTokens: 100 }, verifyCompletion: true, maxIterations: 12 });
    const result = await loop.run('do something', []);
    expect(result).toBe('still working...'); // stopped after the continuation cap, did not hang
  });
});

describe('AgentLoop — plan-mode gating', () => {
  it('refuses to mutate non-md files in plan mode', async () => {
    const provider = scriptedProvider([
      [{ type: 'tool_call', call: { id: 'c1', name: 'create', arguments: { path: 'src/b.ts', _body: 'x' } } }, finish('tool_use')],
      [text('Planned.'), finish('stop')],
    ], true);
    const { ctx, writes } = fakeCtx({ mode: () => 'plan' as AgentMode });
    const loop = new AgentLoop({ provider, registry: buildDefaultRegistry(), ctx, systemPrompt: 'sys', model: 'm', genConfig: { temperature: 0.5, maxOutputTokens: 100 } });
    await loop.run('make b.ts', []);
    expect(writes['src/b.ts']).toBeUndefined();
  });
});
