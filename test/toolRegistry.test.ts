import { describe, it, expect } from 'vitest';
import { buildDefaultRegistry } from '../src/core/tools';

describe('ToolRegistry', () => {
  const reg = buildDefaultRegistry();

  it('registers the core tools', () => {
    for (const name of ['read_file', 'edit', 'create', 'run_command', 'git_status', 'search_web', 'ask_user', 'spawn_agent']) {
      expect(reg.has(name)).toBe(true);
    }
  });

  it('emits native schemas with JSON-schema parameters', () => {
    const schemas = reg.schemas();
    const read = schemas.find((s) => s.name === 'read_file')!;
    expect(read.parameters.type).toBe('object');
    expect(read.parameters.properties.path).toBeTruthy();
  });

  it('filters by an allowlist (always keeping ask_user)', () => {
    const schemas = reg.schemas(['read_file']);
    const names = schemas.map((s) => s.name);
    expect(names).toContain('read_file');
    expect(names).toContain('ask_user');
    expect(names).not.toContain('run_command');
  });

  it('generates an XML definition block for the fallback path', () => {
    const xml = reg.xmlDefinitions(['read_file', 'edit']);
    expect(xml).toContain('<read_file');
    expect(xml).toContain('<edit');
    expect(xml).not.toContain('<run_command');
  });
});
