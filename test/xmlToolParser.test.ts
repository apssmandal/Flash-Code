import { describe, it, expect } from 'vitest';
import { parseXmlToolCalls, isTruncated } from '../src/core/xmlToolParser';

const TOOLS = ['read_file', 'list_files', 'search_files', 'edit', 'create', 'run_command', 'ask_user', 'spawn_agent'];

/** CONTRACT: the XML fallback transport must keep parsing the tags the prompts emit. */
describe('xmlToolParser', () => {
  it('parses a self-closing attribute tag', () => {
    const { calls, prose } = parseXmlToolCalls('Reading. <read_file path="src/a.ts"/> done', TOOLS);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('read_file');
    expect(calls[0].arguments.path).toBe('src/a.ts');
    expect(prose).toContain('Reading.');
    expect(prose).not.toContain('read_file');
  });

  it('parses a body tool and exposes content as _body', () => {
    const xml = '<edit path="f.ts"><<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n</edit>';
    const { calls } = parseXmlToolCalls(xml, TOOLS);
    expect(calls[0].name).toBe('edit');
    expect(calls[0].arguments.path).toBe('f.ts');
    expect(calls[0].arguments._body).toContain('SEARCH');
  });

  it('preserves document order across mixed tags', () => {
    const xml = '<create path="x.ts">X</create><read_file path="y.ts"/>';
    const { calls } = parseXmlToolCalls(xml, TOOLS);
    expect(calls.map((c) => c.name)).toEqual(['create', 'read_file']);
  });

  it('ignores tool tags inside <think> blocks', () => {
    const xml = '<think>I might <run_command command="rm -rf /"/></think><read_file path="a"/>';
    const { calls } = parseXmlToolCalls(xml, TOOLS);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('read_file');
  });

  it('parses multiple independent reads in one turn', () => {
    const xml = '<read_file path="a"/><read_file path="b"/><read_file path="c"/>';
    const { calls } = parseXmlToolCalls(xml, TOOLS);
    expect(calls).toHaveLength(3);
  });

  it('detects truncation of an unclosed body tag', () => {
    expect(isTruncated('<edit path="f">partial without close')).toBe(true);
    expect(isTruncated('<edit path="f">done</edit>')).toBe(false);
    expect(isTruncated('<read_file path="f"/>')).toBe(false);
  });
});
