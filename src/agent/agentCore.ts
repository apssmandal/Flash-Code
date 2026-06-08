
import * as vscode from 'vscode';

export interface AgentPlan {
    steps: string[];
    description: string;
}

import { SUBAGENT_REGISTRY } from '../subagents/registry';
import { Task } from './types';

export class AgentCore {
    private tasks: Task[] = [];

    public async generatePlan(userPrompt: string): Promise<AgentPlan> {
        return {
            description: "Analyzing request...",
            steps: ["Step 1: Parse requirements", "Step 2: Identify files", "Step 3: Propose changes"]
        };
    }

    public async delegate(role: keyof typeof SUBAGENT_REGISTRY, description: string): Promise<string> {
        const config = SUBAGENT_REGISTRY[role];
        console.log(`Delegating to ${role}: ${description}`);
        return `Task assigned to ${role} with system prompt: ${config.systemPrompt}`;
    }
}