import { describe, it, expect } from 'vitest';
import { parseEdits, applyEdits } from '../src/editUtils';

/**
 * CONTRACT TESTS — these lock the exact edit formats that the prompts instruct
 * the model to emit. The prompt rewrite (WS7) MUST keep producing output that
 * satisfies these; if a prompt change breaks the format, these fail first.
 */
describe('editUtils — <create> contract', () => {
  it('parses a <create> block into a full-file edit', () => {
    const text = `prose before
<create path="src/new.ts">
export const x = 1;
</create>
prose after`;
    const edits = parseEdits(text);
    expect(edits).toHaveLength(1);
    expect(edits[0].path).toBe('src/new.ts');
    expect(edits[0].full).toBe('\nexport const x = 1;');
  });

  it('applyEdits returns the full content verbatim for a create', () => {
    const edits = parseEdits('<create path="a.txt">hello\nworld</create>');
    const { content, failures } = applyEdits('', edits[0]);
    expect(failures).toHaveLength(0);
    expect(content).toBe('hello\nworld');
  });
});

describe('editUtils — <edit> SEARCH/REPLACE contract', () => {
  const SR = `<edit path="f.ts">
<<<<<<< SEARCH
const a = 1;
=======
const a = 2;
>>>>>>> REPLACE
</edit>`;

  it('parses the SEARCH/REPLACE markers into a pair', () => {
    const edits = parseEdits(SR);
    expect(edits).toHaveLength(1);
    expect(edits[0].path).toBe('f.ts');
    expect(edits[0].pairs).toEqual([{ search: 'const a = 1;', replace: 'const a = 2;' }]);
  });

  it('applies an exact-match search/replace', () => {
    const old = 'header\nconst a = 1;\nfooter';
    const edits = parseEdits(SR);
    const { content, failures } = applyEdits(old, edits[0]);
    expect(failures).toHaveLength(0);
    expect(content).toBe('header\nconst a = 2;\nfooter');
  });

  it('reports a failure when the SEARCH text is absent', () => {
    const edits = parseEdits(SR);
    const { content, failures } = applyEdits('totally different', edits[0]);
    expect(failures).toHaveLength(1);
    expect(content).toBe('totally different');
  });

  it('matches whitespace-tolerantly when there is a unique normalized match', () => {
    // Source has different indentation than the SEARCH block.
    const old = 'x\n    const a = 1;\ny';
    const edits = parseEdits(SR);
    const { content, failures } = applyEdits(old, edits[0]);
    expect(failures).toHaveLength(0);
    expect(content).toContain('const a = 2;');
  });
});

describe('editUtils — fenced fallback contract', () => {
  it('parses a ```lang:path fenced block as a full-file edit', () => {
    const text = '```ts:src/util.ts\nexport const y = 2;\n```';
    const edits = parseEdits(text);
    expect(edits).toHaveLength(1);
    expect(edits[0].path).toBe('src/util.ts');
    expect(edits[0].full).toBe('export const y = 2;');
  });

  it('does not double-count a path already covered by <create>', () => {
    const text = '<create path="a.ts">A</create>\n```ts:a.ts\nB\n```';
    const edits = parseEdits(text);
    expect(edits).toHaveLength(1);
    expect(edits[0].full).toBe('A');
  });
});
