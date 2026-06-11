import { ToolArgumentError } from '../errors';

/** Clip long text for feeding back to the model (keeps head + tail). */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.floor(max * 0.7)) + '\n…(truncated)…\n' + s.slice(-Math.floor(max * 0.3));
}

/** Require a non-empty string argument or throw a typed error. */
export function reqStr(args: Record<string, any>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) throw new ToolArgumentError(`Missing required string argument "${key}".`);
  return v;
}

export function optStr(args: Record<string, any>, key: string, def = ''): string {
  const v = args[key];
  return typeof v === 'string' ? v : def;
}

/** Reject path-traversal escaping the workspace root. */
export function safeRelPath(p: string): string {
  const norm = p.replace(/\\/g, '/').replace(/^\.\//, '');
  if (norm.startsWith('/') || /^[a-zA-Z]:/.test(norm) || norm.split('/').includes('..')) {
    throw new ToolArgumentError(`Unsafe path "${p}" — must be workspace-relative with no traversal.`);
  }
  return norm;
}

export function safeRegex(p: string): RegExp {
  try { return new RegExp(p, 'i'); } catch { return new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
}

export function globMatch(glob: string, rel: string): boolean {
  const rx = new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '§').replace(/\*/g, '[^/]*').replace(/§/g, '.*') + '$');
  return rx.test(rel);
}
