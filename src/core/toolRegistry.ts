/**
 * Single source of truth for tools. Each tool is declared once with a JSON
 * schema + handler + mode-gating metadata. The registry can then emit:
 *   - native tool schemas (for providers with function calling), and
 *   - an XML tool-definition block (for the fallback path / Ollama),
 * keeping the two transports guaranteed in sync.
 */

import type { JSONSchema, ToolSchema } from '../providers/types';
import type { ToolHandler } from './toolContext';

export type ToolCategory = 'read' | 'write' | 'exec' | 'net' | 'git' | 'control';

export interface ToolDef {
  name: string;
  description: string;
  parameters: JSONSchema;
  handler: ToolHandler;
  /** mutates the workspace/system → needs approval in ask mode */
  mutates: boolean;
  /** explicitly permitted in plan mode (e.g. writing .md/plan files) */
  planAllowed?: boolean;
  category: ToolCategory;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDef>();

  register(def: ToolDef): this {
    this.tools.set(def.name, def);
    return this;
  }

  get(name: string): ToolDef | undefined { return this.tools.get(name); }
  has(name: string): boolean { return this.tools.has(name); }
  list(): ToolDef[] { return [...this.tools.values()]; }

  private filtered(allowed?: string[]): ToolDef[] {
    const defs = this.list();
    if (!allowed?.length) return defs;
    const set = new Set([...allowed, 'ask_user']);
    return defs.filter((d) => set.has(d.name));
  }

  /** Native function-calling schemas. */
  schemas(allowed?: string[]): ToolSchema[] {
    return this.filtered(allowed).map((d) => ({ name: d.name, description: d.description, parameters: d.parameters }));
  }

  /** Human/LLM-readable XML tool definitions for the fallback prompt. */
  xmlDefinitions(allowed?: string[]): string {
    const lines = this.filtered(allowed).map((d) => {
      const attrs = (d.parameters.required ?? Object.keys(d.parameters.properties))
        .map((k) => `${k}="..."`).join(' ');
      const hasBody = d.parameters.properties._body || d.name === 'edit' || d.name === 'create' || d.name === 'run_code';
      const open = `<${d.name}${attrs ? ' ' + attrs : ''}`;
      const tag = hasBody ? `${open}>...</${d.name}>` : `${open}/>`;
      return `  ${tag}  <!-- ${d.description} -->`;
    });
    return lines.join('\n');
  }
}
