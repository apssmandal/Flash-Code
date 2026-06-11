/**
 * Filesystem + edit tools. Edit/create reuse the proven editUtils + diffUtils
 * engine; presentation/approval/writing is delegated to ctx.presentDiff so the
 * mode logic lives in one place.
 */

import type { ToolDef } from '../toolRegistry';
import type { ToolContext } from '../toolContext';
import { applyEdits } from '../../editUtils';
import { clip, reqStr, optStr, safeRelPath, safeRegex, globMatch } from './util';

const obj = (properties: Record<string, any>, required: string[] = []) => ({ type: 'object' as const, properties, required });
const STR = { type: 'string' };

function parseSearchReplace(body: string): { search: string; replace: string }[] {
  const pairs: { search: string; replace: string }[] = [];
  const re = /<<<<<<<\s*SEARCH\s*\n([\s\S]*?)\n?=======\s*\n([\s\S]*?)\n?>>>>>>>\s*REPLACE/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) pairs.push({ search: m[1], replace: m[2] });
  return pairs;
}

export const fileTools: ToolDef[] = [
  {
    name: 'read_file', category: 'read', mutates: false,
    description: 'Read a UTF-8 file from the workspace.',
    parameters: obj({ path: STR }, ['path']),
    handler: async (args, ctx) => {
      const path = safeRelPath(reqStr(args, 'path'));
      try {
        const data = await ctx.readFile(path);
        return `[read_file ${path}]\n` + clip(data, 6000);
      } catch (e: any) { return `[read_file ${path}] ERROR: ${e.message}`; }
    },
  },
  {
    name: 'list_files', category: 'read', mutates: false,
    description: 'List the project file tree.',
    parameters: obj({}),
    handler: async (_args, ctx) => '[list_files]\n' + (await ctx.projectTree()),
  },
  {
    name: 'search_files', category: 'read', mutates: false,
    description: 'Search file contents by regex; optional glob filter. Returns up to 50 matches.',
    parameters: obj({ pattern: STR, glob: STR }, ['pattern']),
    handler: async (args, ctx) => {
      const pattern = reqStr(args, 'pattern');
      const glob = optStr(args, 'glob');
      const rx = safeRegex(pattern);
      const files = await ctx.allFiles();
      const hits: string[] = [];
      for (const rel of files) {
        if (glob && !globMatch(glob, rel)) continue;
        try {
          const txt = await ctx.readFile(rel);
          txt.split('\n').forEach((line, i) => { if (rx.test(line) && hits.length < 50) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 160)}`); });
        } catch { /* unreadable */ }
        if (hits.length >= 50) break;
      }
      return `[search_files ${pattern}]\n` + (hits.join('\n') || '(no matches)');
    },
  },
  {
    name: 'create', category: 'write', mutates: true, planAllowed: false,
    description: 'Create or fully replace a file. Body is the complete file content.',
    parameters: obj({ path: STR, _body: STR }, ['path']),
    handler: async (args, ctx) => writeWhole(args, ctx, 'create'),
  },
  {
    name: 'edit', category: 'write', mutates: true,
    description: 'Edit a file in place. The body MUST contain one or more literal SEARCH/REPLACE blocks and nothing else:\n<<<<<<< SEARCH\n<exact existing lines, verbatim from the current file>\n=======\n<replacement lines>\n>>>>>>> REPLACE\nSEARCH must match the file character-for-character and uniquely (read the file first). Emit one block per region to change. A body without these markers, or whose SEARCH is not found, applies NOTHING and returns "NOT APPLIED" — re-read and retry with exact text. For brand-new files use `create` instead.',
    parameters: obj({ path: STR, _body: STR }, ['path']),
    handler: async (args, ctx) => {
      const path = safeRelPath(reqStr(args, 'path'));
      const body = optStr(args, '_body');
      const pairs = parseSearchReplace(body);
      if (!pairs.length) {
        return `[edit ${path}] NOT APPLIED — no valid SEARCH/REPLACE blocks were found in the edit body. The file was NOT changed.\nUse this EXACT format (one or more blocks):\n<<<<<<< SEARCH\n<exact existing lines>\n=======\n<replacement lines>\n>>>>>>> REPLACE\nRe-issue the edit with proper blocks.`;
      }
      const existed = await ctx.fileExists(path);
      const old = existed ? await ctx.readFile(path) : '';
      const { content, failures } = applyEdits(old, { path, pairs });
      if (content === old) {
        const why = failures.length
          ? `the SEARCH text was not found (${failures.join('; ')})`
          : 'the replacement is identical to the text already in the file';
        return `[edit ${path}] NOT APPLIED — ${why}. The file was NOT changed.\nCurrent content:\n` + clip(old, 6000) + '\nRe-read the file and retry with the EXACT existing text in SEARCH.';
      }
      const applied = await ctx.presentDiff(path, old, content);
      return `[edit ${path}] ${applied ? 'applied.' : 'rejected by user.'}`;
    },
  },
  {
    name: 'overwrite_file', category: 'write', mutates: true,
    description: 'Replace a file\'s entire content with the body.',
    parameters: obj({ path: STR, _body: STR }, ['path']),
    handler: async (args, ctx) => writeWhole(args, ctx, 'overwrite_file'),
  },
  {
    name: 'append_file', category: 'write', mutates: true,
    description: 'Append the body to the end of a file.',
    parameters: obj({ path: STR, _body: STR }, ['path']),
    handler: async (args, ctx) => {
      const path = safeRelPath(reqStr(args, 'path'));
      const existed = await ctx.fileExists(path);
      const old = existed ? await ctx.readFile(path) : '';
      const next = old + (old.endsWith('\n') || !old ? '' : '\n') + optStr(args, '_body');
      const applied = await ctx.presentDiff(path, old, next);
      return `[append_file ${path}] ${applied ? 'applied.' : 'rejected.'}`;
    },
  },
  {
    name: 'delete_file', category: 'write', mutates: true,
    description: 'Delete a file.',
    parameters: obj({ path: STR }, ['path']),
    handler: async (args, ctx) => {
      const path = safeRelPath(reqStr(args, 'path'));
      if (!(await ctx.askApproval('write', `Delete ${path}?`))) return `[delete_file ${path}] rejected.`;
      const existed = await ctx.fileExists(path);
      const old = existed ? await ctx.readFile(path) : '';
      ctx.recordSnapshot(path, old, existed);
      await ctx.deleteFile(path);
      return `[delete_file ${path}] deleted.`;
    },
  },
  {
    name: 'rename_file', category: 'write', mutates: true,
    description: 'Rename/move a file.',
    parameters: obj({ src: STR, dest: STR }, ['src', 'dest']),
    handler: async (args, ctx) => {
      const src = safeRelPath(reqStr(args, 'src'));
      const dest = safeRelPath(reqStr(args, 'dest'));
      await ctx.renameFile(src, dest);
      return `[rename_file] ${src} → ${dest}`;
    },
  },
  {
    name: 'copy_file', category: 'write', mutates: true,
    description: 'Copy a file.',
    parameters: obj({ src: STR, dest: STR }, ['src', 'dest']),
    handler: async (args, ctx) => {
      const src = safeRelPath(reqStr(args, 'src'));
      const dest = safeRelPath(reqStr(args, 'dest'));
      await ctx.copyFile(src, dest);
      return `[copy_file] ${src} → ${dest}`;
    },
  },
  {
    name: 'read_dir', category: 'read', mutates: false,
    description: 'List entries of a directory.',
    parameters: obj({ path: STR }, ['path']),
    handler: async (args, ctx) => {
      const path = safeRelPath(optStr(args, 'path', '.'));
      const entries = await ctx.listDir(path);
      return '[read_dir]\n' + entries.map((e) => e.name + (e.isDir ? '/' : '')).join('\n');
    },
  },
  {
    name: 'create_dir', category: 'write', mutates: true,
    description: 'Create a directory.',
    parameters: obj({ path: STR }, ['path']),
    handler: async (args, ctx) => { const path = safeRelPath(reqStr(args, 'path')); await ctx.createDir(path); return `[create_dir ${path}] created.`; },
  },
  {
    name: 'get_file_info', category: 'read', mutates: false,
    description: 'Get size and modified time of a file.',
    parameters: obj({ path: STR }, ['path']),
    handler: async (args, ctx) => {
      const path = safeRelPath(reqStr(args, 'path'));
      const s = await ctx.stat(path);
      return `[get_file_info ${path}]\nSize: ${s.size} bytes\nModified: ${new Date(s.mtime).toISOString()}`;
    },
  },
  {
    name: 'read_json', category: 'read', mutates: false,
    description: 'Read and pretty-print a JSON file, optionally a single top-level key.',
    parameters: obj({ path: STR, key: STR }, ['path']),
    handler: async (args, ctx) => {
      const path = safeRelPath(reqStr(args, 'path'));
      const obj2 = JSON.parse(await ctx.readFile(path));
      const key = optStr(args, 'key');
      return '[read_json]\n' + JSON.stringify(key ? obj2[key] : obj2, null, 2);
    },
  },
  {
    name: 'format_json', category: 'write', mutates: true,
    description: 'Pretty-print a JSON file in place.',
    parameters: obj({ path: STR }, ['path']),
    handler: async (args, ctx) => {
      const path = safeRelPath(reqStr(args, 'path'));
      const old = await ctx.readFile(path);
      const formatted = JSON.stringify(JSON.parse(old), null, 2);
      const applied = await ctx.presentDiff(path, old, formatted);
      return `[format_json ${path}] ${applied ? 'formatted.' : 'rejected.'}`;
    },
  },
];

async function writeWhole(args: Record<string, any>, ctx: ToolContext, tool: string): Promise<string> {
  const path = safeRelPath(reqStr(args, 'path'));
  const body = optStr(args, '_body').replace(/\n$/, '');
  const existed = await ctx.fileExists(path);
  const old = existed ? await ctx.readFile(path) : '';
  if (existed && body === old) {
    return `[${tool} ${path}] NOT APPLIED — the new content is identical to the current file. The file was NOT changed.`;
  }
  const applied = await ctx.presentDiff(path, old, body);
  return `[${tool} ${path}] ${applied ? 'applied.' : 'rejected by user.'}`;
}
