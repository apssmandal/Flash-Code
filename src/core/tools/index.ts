/** Assembles the default tool registry from all tool groups. */

import { ToolRegistry } from '../toolRegistry';
import { fileTools } from './fileTools';
import { execTools } from './execTools';

export function buildDefaultRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  for (const t of [...fileTools, ...execTools]) reg.register(t);
  return reg;
}

export { fileTools, execTools };
