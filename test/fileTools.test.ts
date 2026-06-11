import { describe, it, expect } from 'vitest';
import { buildDefaultRegistry } from '../src/core/tools';
import type { ToolContext } from '../src/core/toolContext';

function fakeCtx(seed: Record<string, string> = {}): { ctx: ToolContext; files: Record<string, string>; approvals: boolean } {
  const files = { ...seed };
  const state = { approvals: true };
  const ctx: ToolContext = {
    readFile: async (p) => { if (p in files) return files[p]; throw new Error('ENOENT'); },
    writeFile: async (p, c) => { files[p] = c; },
    fileExists: async (p) => p in files,
    deleteFile: async (p) => { delete files[p]; },
    renameFile: async (s, d) => { files[d] = files[s]; delete files[s]; },
    copyFile: async (s, d) => { files[d] = files[s]; },
    listDir: async () => [{ name: 'a.ts', isDir: false }],
    createDir: async () => {},
    stat: async () => ({ size: 10, mtime: 0 }),
    projectTree: async () => 'tree',
    allFiles: async () => Object.keys(files),
    workspaceRoot: () => '/ws',
    runCommand: async () => ({ code: 0, output: '' }),
    runExec: async () => ({ code: 0, output: '' }),
    fetchText: async () => '',
    mode: () => 'autonomous',
    emit: () => {},
    askApproval: async () => state.approvals,
    askUser: async () => 'ok',
    presentDiff: async (p, _o, n) => { files[p] = n; return true; },
    recordSnapshot: () => {},
    spawn: async () => 'done',
  };
  return { ctx, files, get approvals() { return state.approvals; }, set approvals(v: boolean) { state.approvals = v; } } as any;
}

const reg = buildDefaultRegistry();
const call = (name: string, args: any, ctx: ToolContext) => reg.get(name)!.handler(args, ctx);

describe('file tools', () => {
  it('read_file returns content and errors cleanly on missing files', async () => {
    const { ctx } = fakeCtx({ 'a.ts': 'hello' });
    expect(await call('read_file', { path: 'a.ts' }, ctx)).toContain('hello');
    expect(await call('read_file', { path: 'missing.ts' }, ctx)).toContain('ERROR');
  });

  it('rejects path traversal', async () => {
    const { ctx } = fakeCtx();
    await expect(call('read_file', { path: '../../etc/passwd' }, ctx)).rejects.toThrow(/Unsafe path/);
  });

  it('create writes the full body via presentDiff', async () => {
    const { ctx, files } = fakeCtx();
    await call('create', { path: 'new.ts', _body: 'export const x = 1;\n' }, ctx);
    expect(files['new.ts']).toBe('export const x = 1;');
  });

  it('edit applies a SEARCH/REPLACE hunk', async () => {
    const { ctx, files } = fakeCtx({ 'a.ts': 'const a = 1;' });
    const body = '<<<<<<< SEARCH\nconst a = 1;\n=======\nconst a = 2;\n>>>>>>> REPLACE';
    await call('edit', { path: 'a.ts', _body: body }, ctx);
    expect(files['a.ts']).toBe('const a = 2;');
  });

  it('edit reports a self-correcting error when SEARCH is absent', async () => {
    const { ctx } = fakeCtx({ 'a.ts': 'something else' });
    const body = '<<<<<<< SEARCH\nnope\n=======\nx\n>>>>>>> REPLACE';
    const res = await call('edit', { path: 'a.ts', _body: body }, ctx);
    expect(res).toContain('not found');
  });

  it('edit does NOT report "applied" when the body has no valid blocks', async () => {
    const { ctx, files } = fakeCtx({ 'a.ts': 'const a = 1;' });
    const res = await call('edit', { path: 'a.ts', _body: 'just add the past 7 days feature' }, ctx);
    expect(res).toContain('NOT APPLIED');
    expect(res).not.toContain('applied.');
    expect(files['a.ts']).toBe('const a = 1;'); // unchanged
  });

  it('edit does NOT report "applied" for a no-op replacement', async () => {
    const { ctx, files } = fakeCtx({ 'a.ts': 'const a = 1;' });
    const body = '<<<<<<< SEARCH\nconst a = 1;\n=======\nconst a = 1;\n>>>>>>> REPLACE';
    const res = await call('edit', { path: 'a.ts', _body: body }, ctx);
    expect(res).toContain('NOT APPLIED');
    expect(files['a.ts']).toBe('const a = 1;'); // unchanged
  });

  it('overwrite_file does NOT report "applied" when content is identical', async () => {
    const { ctx } = fakeCtx({ 'a.ts': 'const a = 1;' });
    const res = await call('overwrite_file', { path: 'a.ts', _body: 'const a = 1;' }, ctx);
    expect(res).toContain('NOT APPLIED');
  });

  it('search_files finds matching lines', async () => {
    const { ctx } = fakeCtx({ 'a.ts': 'foo\nbar', 'b.ts': 'baz' });
    const res = await call('search_files', { pattern: 'ba' }, ctx);
    expect(res).toContain('a.ts:2');
    expect(res).toContain('b.ts:1');
  });

  it('delete_file removes the file when approved and respects rejection', async () => {
    const c = fakeCtx({ 'a.ts': 'x' });
    await call('delete_file', { path: 'a.ts' }, c.ctx);
    expect('a.ts' in c.files).toBe(false);

    const c2 = fakeCtx({ 'b.ts': 'y' });
    (c2 as any).approvals = false;
    const res = await call('delete_file', { path: 'b.ts' }, c2.ctx);
    expect(res).toContain('rejected');
    expect('b.ts' in c2.files).toBe(true);
  });
});
