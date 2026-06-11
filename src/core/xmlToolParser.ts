/**
 * XML tool-tag parser — the fallback transport for models without native
 * function calling (Ollama, older locals). Pure and fully unit-testable.
 *
 * Recognizes both self-closing attribute tags (`<read_file path="…"/>`) and
 * body tags (`<edit path="…">…</edit>`). Body content is exposed as the special
 * `_body` argument so handlers share one shape with the native path. Tags inside
 * <think>/<thought> blocks are ignored so hallucinated calls never execute.
 */

import type { ToolCallRequest } from '../providers/types';

/** Tools whose payload is an XML element body rather than attributes. */
const BODY_TOOLS = new Set(['edit', 'create', 'overwrite_file', 'append_file', 'run_code', 'ask_user']);

export interface XmlParseResult {
  calls: ToolCallRequest[];
  /** prose with all tool tags + think/thought blocks stripped */
  prose: string;
}

const THINK_RE = /<think\b[^>]*>[\s\S]*?<\/think>|<thought\b[^>]*>[\s\S]*?<\/thought>/g;

function parseAttrs(s: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /(\w+)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) attrs[m[1]] = m[2];
  return attrs;
}

export function parseXmlToolCalls(buf: string, knownTools: readonly string[]): XmlParseResult {
  const active = buf.replace(THINK_RE, '');
  const calls: { call: ToolCallRequest; raw: string }[] = [];
  let counter = 0;
  const id = () => `xml_${++counter}`;

  // Body tools first (greedy bodies), then self-closing tags.
  for (const tool of knownTools) {
    if (BODY_TOOLS.has(tool)) {
      const re = new RegExp(`<${tool}\\b([^>]*?)>([\\s\\S]*?)<\\/${tool}>`, 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(active)) !== null) {
        const args = parseAttrs(m[1] || '');
        args._body = m[2] ?? '';
        calls.push({ call: { id: id(), name: tool, arguments: args }, raw: m[0] });
      }
    } else {
      const re = new RegExp(`<${tool}\\b([^>]*?)\\/?>`, 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(active)) !== null) {
        calls.push({ call: { id: id(), name: tool, arguments: parseAttrs(m[1] || '') }, raw: m[0] });
      }
    }
  }

  // Document order so a write/ask appearing before reads is honored.
  calls.sort((a, b) => active.indexOf(a.raw) - active.indexOf(b.raw));

  // Prose = everything minus think blocks and tool tags.
  let prose = active;
  for (const c of calls) prose = prose.replace(c.raw, '');
  prose = prose.trim();

  return { calls: calls.map((c) => c.call), prose };
}

/** Detect an unclosed body tag → the model's response was truncated mid-tool. */
export function isTruncated(buf: string): boolean {
  for (const t of BODY_TOOLS) {
    if (new RegExp(`<${t}\\b`).test(buf) && !buf.includes(`</${t}>`)) return true;
  }
  return false;
}
