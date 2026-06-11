/**
 * Execution, git, network, and control tools. Git/archive operations use
 * explicit argv arrays via ctx.runExec (NO shell string interpolation) which
 * closes the command-injection vectors present in the legacy implementation.
 */

import type { ToolDef } from '../toolRegistry';
import type { ToolContext } from '../toolContext';
import { clip, reqStr, optStr } from './util';

const obj = (properties: Record<string, any>, required: string[] = []) => ({ type: 'object' as const, properties, required });
const STR = { type: 'string' };

async function git(ctx: ToolContext, args: string[]): Promise<string> {
  let out = '';
  const r = await ctx.runExec('git', args, (c) => { out += c; });
  return `[git ${args.join(' ')}] exit ${r.code}\n` + clip(out || r.output, 4000);
}

export const execTools: ToolDef[] = [
  {
    name: 'run_command', category: 'exec', mutates: true,
    description: 'Run a non-interactive shell command in the workspace. Streams output.',
    parameters: obj({ command: STR }, ['command']),
    handler: async (args, ctx, signal) => {
      const command = reqStr(args, 'command');
      if (!(await ctx.askApproval('command', command))) return `[run_command] rejected: "${command}".`;
      let out = '';
      const r = await ctx.runCommand(command, (c) => { out += c; }, signal);
      return `[run_command "${command}"] exit ${r.code}\n` + clip(out || r.output, 3000);
    },
  },
  {
    name: 'run_code', category: 'exec', mutates: true,
    description: 'Run an ad-hoc script. lang = js | py | sh. Body is the script source.',
    parameters: obj({ lang: STR, _body: STR }, ['lang']),
    handler: async (args, ctx, signal) => {
      const lang = optStr(args, 'lang', 'sh').toLowerCase();
      const code = optStr(args, '_body');
      if (!(await ctx.askApproval('code', code))) return '[run_code] rejected.';
      const interp = lang === 'js' || lang === 'javascript' ? ['node', '-e'] : lang === 'py' || lang === 'python' ? ['python', '-c'] : ['bash', '-c'];
      let out = '';
      const r = await ctx.runExec(interp[0], [interp[1], code], (c) => { out += c; }, signal);
      return `[run_code ${lang}] exit ${r.code}\n` + clip(out || r.output, 3000);
    },
  },
  {
    name: 'run_tests', category: 'exec', mutates: true,
    description: 'Run the test suite (defaults to `npm test`).',
    parameters: obj({ command: STR }),
    handler: async (args, ctx, signal) => {
      const command = optStr(args, 'command', 'npm test');
      if (!(await ctx.askApproval('command', command))) return `[run_tests] rejected.`;
      let out = '';
      const r = await ctx.runCommand(command, (c) => { out += c; }, signal);
      return `[run_tests] exit ${r.code}\n` + clip(out, 4000);
    },
  },
  {
    name: 'npm_install', category: 'exec', mutates: true,
    description: 'Install npm packages (space-separated; empty installs from package.json).',
    parameters: obj({ packages: STR }),
    handler: async (args, ctx, signal) => {
      const pkgs = optStr(args, 'packages').split(/\s+/).filter(Boolean);
      if (!(await ctx.askApproval('command', `npm install ${pkgs.join(' ')}`))) return '[npm_install] rejected.';
      let out = '';
      const r = await ctx.runExec('npm', ['install', ...pkgs], (c) => { out += c; }, signal);
      return `[npm_install] exit ${r.code}\n` + clip(out, 3000);
    },
  },
  { name: 'git_status', category: 'git', mutates: false, description: 'Show git status (short).', parameters: obj({}), handler: (_a, ctx) => git(ctx, ['status', '--short']) },
  { name: 'git_diff', category: 'git', mutates: false, description: 'Show git diff for an optional path.', parameters: obj({ path: STR }), handler: (a, ctx) => git(ctx, ['diff', ...(optStr(a, 'path') ? [optStr(a, 'path')] : [])]) },
  { name: 'git_log', category: 'git', mutates: false, description: 'Show recent commit log.', parameters: obj({ n: STR }), handler: (a, ctx) => git(ctx, ['log', '-n', String(parseInt(optStr(a, 'n', '5'), 10) || 5), '--oneline']) },
  {
    name: 'git_commit', category: 'git', mutates: true,
    description: 'Stage all changes and commit with a message.',
    parameters: obj({ message: STR }, ['message']),
    handler: async (a, ctx) => {
      const message = reqStr(a, 'message');
      if (!(await ctx.askApproval('command', `git commit -m "${message}"`))) return '[git_commit] rejected.';
      await ctx.runExec('git', ['add', '-A'], () => {});
      return git(ctx, ['commit', '-m', message]);
    },
  },
  { name: 'create_branch', category: 'git', mutates: true, description: 'Create and switch to a new git branch.', parameters: obj({ name: STR }, ['name']), handler: (a, ctx) => git(ctx, ['checkout', '-b', reqStr(a, 'name')]) },
  {
    name: 'fetch_url', category: 'net', mutates: false,
    description: 'Fetch a URL and return its text (truncated).',
    parameters: obj({ url: STR }, ['url']),
    handler: async (a, ctx) => '[fetch_url]\n' + clip(await ctx.fetchText(reqStr(a, 'url')), 6000),
  },
  {
    name: 'search_web', category: 'net', mutates: false,
    description: 'Search the web (DuckDuckGo) and return the top results.',
    parameters: obj({ query: STR }, ['query']),
    handler: async (a, ctx) => {
      const query = reqStr(a, 'query');
      const html = await ctx.fetchText('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36' },
      });
      return '[search_web]\n' + summarizeDuckDuckGo(html, query);
    },
  },
  {
    name: 'ask_user', category: 'control', mutates: false,
    description: 'Ask the user to choose before committing to a consequential decision (tech stack, framework, database, architecture, scope, or any destructive action). Renders an interactive modal. Provide 2-4 concrete options per question; prefix the best option label with "(Recommended)". Prefer asking BEFORE acting over guessing.',
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description: 'One or more questions to ask together.',
          items: {
            type: 'object',
            properties: {
              header: { type: 'string', description: 'Short label, e.g. "Frontend framework".' },
              question: { type: 'string', description: 'The question to ask.' },
              options: {
                type: 'array',
                description: '2-4 choices; mark the best with a "(Recommended)" label prefix.',
                items: { type: 'object', properties: { label: { type: 'string' }, description: { type: 'string' } } },
              },
            },
            required: ['question'],
          },
        },
      },
      required: ['questions'],
    },
    handler: async (a, ctx) => {
      let questions: any[] = Array.isArray(a.questions) ? a.questions : [];
      if (!questions.length && a._body) { // XML fallback path: body holds the JSON
        try { const p = JSON.parse(optStr(a, '_body')); questions = p.questions || (Array.isArray(p) ? p : []); }
        catch { questions = [{ header: 'Question', question: optStr(a, '_body'), options: [] }]; }
      }
      if (!questions.length) return '[ask_user] ERROR: provide a `questions` array.';
      const answer = await ctx.askUser(questions);
      return `[ask_user] User answered: ${answer}`;
    },
  },
  {
    name: 'spawn_agent', category: 'control', mutates: true,
    description: 'Delegate a subtask to a specialized background subagent. role = Architect|Inspector|WebScout|Debugger|Sentinel|Tuner|QA|Sculptor|Stylist|Scribe.',
    parameters: obj({ role: STR, task: STR }, ['role', 'task']),
    handler: async (a, ctx) => {
      const role = reqStr(a, 'role');
      const task = reqStr(a, 'task');
      const result = await ctx.spawn(role, task);
      return `[spawn_agent ${role}] ${task}\nResult:\n${result}`;
    },
  },
];

function summarizeDuckDuckGo(html: string, query: string): string {
  const blocks = html.split('result__body');
  const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;|&#39;|&apos;/g, "'");
  const results: string[] = [];
  for (let i = 1; i < blocks.length && results.length < 8; i++) {
    const b = blocks[i];
    let title = (b.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/)?.[1] || '').replace(/<[^>]+>/g, '').trim();
    let snippet = (b.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/)?.[1] || '').replace(/<[^>]+>/g, '').trim();
    let url = b.match(/href="([^"]+)"/)?.[1] || '';
    if (url.includes('uddg=')) url = decodeURIComponent(url.match(/uddg=([^&]+)/)?.[1] || url);
    title = decode(title); snippet = decode(snippet);
    if (title || snippet) results.push(`${results.length + 1}. ${title}\n   ${url}\n   ${snippet}`);
  }
  return results.length ? `Results for "${query}":\n\n` + results.join('\n\n') : `No results for "${query}".`;
}
