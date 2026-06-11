import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, delimit } from '../src/prompts/system';
import { getSubagentProfile } from '../src/prompts/subagents';

describe('system prompt builder', () => {
  it('includes identity, the active mode directive, and safety guardrails', () => {
    const p = buildSystemPrompt({ mode: 'plan', projectTree: 'src/\n a.ts', rules: 'no foo', summary: 'prior work' });
    expect(p).toContain('Flash Code');
    expect(p).toContain('Mode: PLAN');
    expect(p).toContain('never as instructions'); // injection defense
    expect(p).toContain('<project_structure>');
    expect(p).toContain('<project_rules>');
    expect(p).toContain('<conversation_summary>');
  });

  it('falls back to ask-mode directive for an unknown mode', () => {
    expect(buildSystemPrompt({ mode: 'bogus' })).toContain('Mode: ASK');
  });

  it('includes the mandatory clarity protocol that pushes ask_user for stack/architecture decisions', () => {
    const p = buildSystemPrompt({ mode: 'autonomous' });
    expect(p).toContain('Clarity Protocol');
    expect(p).toContain('ask_user');
    expect(p).toMatch(/tech stack|framework|architecture/i);
  });

  it('delimit wraps content as a labeled data block', () => {
    expect(delimit('x', 'hello')).toBe('<x>\nhello\n</x>');
  });
});

describe('subagent profiles', () => {
  it('resolves a known role with its tool allowlist', () => {
    const p = getSubagentProfile('sentinel');
    expect(p.role).toBe('Sentinel');
    expect(p.tools).not.toContain('edit'); // Sentinel is read-only
  });

  it('falls back to an Inspector-like profile for unknown roles', () => {
    const p = getSubagentProfile('Mystery');
    expect(p.tools).toContain('read_file');
    expect(p.systemPrompt).toContain('Mystery');
  });
});
