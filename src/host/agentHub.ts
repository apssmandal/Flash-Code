/** Broadcasts subagent lifecycle events so the Mission Control dashboard can
 * mirror what the chat panel shows, even though they're separate webviews. */
import * as vscode from 'vscode';
import type { AgentEvent } from '../core/events';

export const agentHub = new vscode.EventEmitter<AgentEvent>();
