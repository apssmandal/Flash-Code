/**
 * Classify a shell command into a coarse "permission category" so the chat UI
 * can offer "allow this KIND of command for the rest of the thread" without
 * blanket-approving genuinely different (network / mutating / VCS-write)
 * commands.
 *
 * Read-only inspection commands (read / search / list a file or the tree)
 * collapse into a single `read` category — so the user grants once and the
 * agent's flailing `type` / `findstr` / `Get-Content | Select-String` attempts
 * all pass. Anything else is keyed by its primary executable, so allowing
 * `npm` never silently allows `git push`.
 */

/** Programs that only read/inspect — no filesystem, network, or process side effects. */
const READ_ONLY = new Set([
  'type', 'cat', 'more', 'less', 'head', 'tail', 'nl', 'tac',
  'findstr', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack',
  'select-string', 'sls', 'get-content', 'gc',
  'ls', 'dir', 'gci', 'get-childitem', 'tree', 'find', 'where', 'which', 'whereis',
  'echo', 'pwd', 'cd', 'wc', 'stat', 'file', 'sort', 'uniq', 'cut', 'fc', 'comm',
  'test-path', 'get-item', 'gi', 'get-location', 'gl', 'measure-object', 'select-object',
  'basename', 'dirname', 'realpath', 'readlink', 'cksum', 'md5sum', 'sha1sum', 'sha256sum',
  'date', 'hostname', 'whoami', 'env', 'printenv', 'cmp',
]);

/** `git <sub>` subcommands that only read repository state. */
const GIT_READ = new Set([
  'status', 'log', 'diff', 'show', 'branch', 'remote', 'ls-files', 'rev-parse',
  'describe', 'blame', 'tag', 'shortlog', 'reflog', 'whatchanged', 'cat-file', 'ls-tree',
]);

/** Leading executable of a segment, stripped of path + extension, lower-cased. */
function leadToken(seg: string): string {
  const raw = seg.trim().split(/\s+/)[0] ?? '';
  const base = raw.replace(/^["']|["']$/g, '').split(/[\\/]/).pop() ?? raw;
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
}

/** Unwrap `powershell -Command "<inner>"`, `pwsh -c '<inner>'`, `cmd /c <inner>` to the inner command. */
function unwrap(raw: string): string {
  const m = raw.trim().match(/^(?:powershell|pwsh|cmd)(?:\.exe)?\b[\s\S]*?(?:-command|-c|\/c)\s+([\s\S]+)$/i);
  if (!m) return raw.trim();
  let inner = m[1].trim();
  if ((inner.startsWith('"') && inner.endsWith('"')) || (inner.startsWith("'") && inner.endsWith("'"))) {
    inner = inner.slice(1, -1);
  }
  return inner.trim();
}

function isReadOnlySeg(seg: string): boolean {
  const tok = leadToken(seg);
  if (READ_ONLY.has(tok)) return true;
  if (tok === 'git') {
    const sub = (seg.trim().split(/\s+/)[1] ?? '').toLowerCase();
    return GIT_READ.has(sub);
  }
  return false;
}

export interface CommandClass {
  /** Stable key used to remember per-thread grants. */
  category: string;
  /** Human-readable description of what allowing this category covers. */
  label: string;
}

/**
 * Classify a command. Pure and host-agnostic so it stays unit-testable.
 * - All segments read-only            → `read`
 * - otherwise keyed by primary exe    → `exec:<program>`
 */
export function classifyCommand(raw: string): CommandClass {
  const inner = unwrap(raw || '');
  const segments = inner.split(/\|\|?|&&?|;/).map((s) => s.trim()).filter(Boolean);
  if (segments.length && segments.every(isReadOnlySeg)) {
    return { category: 'read', label: 'read-only inspection commands (read / search / list files)' };
  }
  const firstRisky = segments.find((s) => !isReadOnlySeg(s)) ?? segments[0] ?? inner;
  const exe = leadToken(firstRisky) || 'command';
  return { category: 'exec:' + exe, label: `“${exe}” commands` };
}
