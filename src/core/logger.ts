/**
 * Tiny leveled logger. Routes through a VS Code OutputChannel when available,
 * otherwise console. Never log secrets — `redact()` masks anything key-shaped.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogSink {
  appendLine(line: string): void;
}

let sink: LogSink | null = null;
let minLevel: LogLevel = 'info';

export function configureLogger(s: LogSink, level: LogLevel = 'info') {
  sink = s;
  minLevel = level;
}

/** Mask anything that looks like an API key/token so it never reaches logs. */
export function redact(value: string): string {
  return value
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, 'sk-***')
    .replace(/\b(AIza[A-Za-z0-9_-]{10,})\b/g, 'AIza***')
    .replace(/\b(gsk_[A-Za-z0-9_-]{8,})\b/g, 'gsk_***')
    .replace(/\b([A-Za-z0-9_-]{32,})\b/g, (m) => m.slice(0, 4) + '***');
}

function emit(level: LogLevel, scope: string, args: unknown[]) {
  if (LEVELS[level] < LEVELS[minLevel]) return;
  const msg = args
    .map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()))
    .join(' ');
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${scope}: ${redact(msg)}`;
  if (sink) sink.appendLine(line);
  else if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export function createLogger(scope: string) {
  return {
    debug: (...a: unknown[]) => emit('debug', scope, a),
    info: (...a: unknown[]) => emit('info', scope, a),
    warn: (...a: unknown[]) => emit('warn', scope, a),
    error: (...a: unknown[]) => emit('error', scope, a),
  };
}
