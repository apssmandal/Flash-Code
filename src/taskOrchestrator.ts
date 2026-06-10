import * as vscode from 'vscode';
import { KeyStatus } from './backends/types';
import { GitUtils } from './gitUtils';

export interface AgentState {
    id: string;
    role: string;
    objective: string;
    status: 'Analyzing' | 'Planning' | 'Executing' | 'Awaiting_Approval' | 'Completed' | 'Error';
    progress: string;
    createdAt: number;
    worktreeUri?: string;
}

interface QueuedRequest {
    priority: number;
    execute: (key: string, idx: number) => Promise<any>;
    resolve: (value: any) => void;
    reject: (reason?: any) => void;
    onWait?: (msg: string) => void;
    signal?: AbortSignal;
}

export class TaskDispatcher {
    private static instance: TaskDispatcher;
    
    public agents: Map<string, AgentState> = new Map();
    public onStateChange?: () => void;

    private requestQueue: QueuedRequest[] = [];
    private isProcessingQueue = false;

    // Key Management
    private keyIndex = 0;
    private keyCooldowns: Map<number, number> = new Map();
    private activeRequestsPerKey: Map<number, number> = new Map();
    
    public static getInstance(): TaskDispatcher {
        if (!TaskDispatcher.instance) {
            TaskDispatcher.instance = new TaskDispatcher();
        }
        return TaskDispatcher.instance;
    }

    public registerAgent(id: string, role: string, objective: string) {
        this.agents.set(id, {
            id, role, objective, status: 'Analyzing', progress: 'Initializing...', createdAt: Date.now()
        });
        this.notify();
    }

    /**
     * Spawns an agent inside an isolated git worktree sandbox.
     */
    public async spawnAgentWithWorktree(id: string, role: string, objective: string): Promise<string | undefined> {
        this.registerAgent(id, role, objective);
        
        const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!ws) {
            this.updateAgent(id, 'Error', 'No active workspace to branch from.');
            return;
        }

        try {
            this.updateAgent(id, 'Analyzing', 'Creating isolated worktree sandbox...');
            const worktreePath = await GitUtils.createWorktree(ws, id);
            
            const agent = this.agents.get(id);
            if (agent) agent.worktreeUri = vscode.Uri.file(worktreePath).toString();
            
            this.updateAgent(id, 'Analyzing', 'Sandbox ready. Booting up...');
            return worktreePath;
        } catch (error: any) {
            this.updateAgent(id, 'Error', `Failed to create worktree: ${error.message}`);
        }
    }

    /**
     * Approves an agent's task, automatically merging its worktree into main and cleaning it up.
     */
    public async approveAgentTask(id: string, mainBranch: string = 'main') {
        const agent = this.agents.get(id);
        if (!agent || agent.status !== 'Awaiting_Approval') return;

        const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!ws) return;

        try {
            this.updateAgent(id, 'Executing', 'Merging worktree back to main...');
            await GitUtils.mergeWorktree(ws, id, mainBranch);
            
            this.updateAgent(id, 'Executing', 'Cleaning up sandbox...');
            await GitUtils.removeWorktree(ws, id);

            this.updateAgent(id, 'Completed', 'Merged and cleaned up successfully.');
        } catch (error: any) {
            this.updateAgent(id, 'Error', `Merge failed: ${error.message}`);
        }
    }

    public updateAgent(id: string, status: AgentState['status'], progress: string) {
        const agent = this.agents.get(id);
        if (agent) {
            agent.status = status;
            agent.progress = progress;
            this.notify();
        }
    }

    public removeAgent(id: string) {
        this.agents.delete(id);
        this.notify();
    }

    private notify() {
        if (this.onStateChange) this.onStateChange();
    }

    // --- PACING THROTTLER & KEY WHEEL ---

    private loadKeys(): string[] {
        const cfg = vscode.workspace.getConfiguration('flashCode');
        const keys = (cfg.get<string[]>('gemini.apiKeys') || []).filter(Boolean);
        const single = cfg.get<string>('gemini.apiKey') || '';
        return keys.length ? keys : (single ? [single] : []);
    }

    /**
     * Enqueues an LLM request to be dispatched evenly across the key pool.
     */
    public enqueueRequest<T>(priority: number, execute: (key: string, idx: number) => Promise<T>, onWait?: (msg: string) => void, signal?: AbortSignal): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            if (signal?.aborted) return reject(new Error('Cancelled'));
            this.requestQueue.push({ priority, execute, resolve, reject, onWait, signal });
            this.requestQueue.sort((a, b) => b.priority - a.priority); // Highest priority first
            this.processQueue();
        });
    }

    private async processQueue() {
        if (this.isProcessingQueue || this.requestQueue.length === 0) return;
        this.isProcessingQueue = true;

        try {
            while (this.requestQueue.length > 0) {
                // Drop aborted requests immediately
                if (this.requestQueue[0].signal?.aborted) {
                    this.requestQueue.shift()?.reject(new Error('Cancelled'));
                    continue;
                }
                const keys = this.loadKeys();
                if (!keys.length) {
                    const req = this.requestQueue.shift();
                    req?.reject(new Error('No Gemini API keys configured.'));
                    continue;
                }

                // Find perfectly balanced next key (fewest active requests, not in cooldown)
                let bestIdx = -1;
                let minActive = Infinity;
                const now = Date.now();

                // To ensure true round-robin we also check from keyIndex
                for (let i = 0; i < keys.length; i++) {
                    const idx = (this.keyIndex + i) % keys.length;
                    const cooldown = this.keyCooldowns.get(idx) || 0;
                    if (cooldown > now) continue; // Skip cooling down keys

                    const active = this.activeRequestsPerKey.get(idx) || 0;
                    // Strict limit per key to prevent bursting, e.g., max 2 concurrent requests per key
                    if (active < minActive) {
                        minActive = active;
                        bestIdx = idx;
                    }
                }

                if (bestIdx === -1) {
                    // All keys are on cooldown. Wait a bit and try again.
                    const minWaitMs = Array.from(this.keyCooldowns.values())
                        .filter(c => c > now)
                        .reduce((min, c) => Math.min(min, c - now), Infinity);
                    
                    if (minWaitMs !== Infinity && this.requestQueue[0]?.onWait) {
                        const waitSecs = Math.ceil(minWaitMs / 1000);
                        this.requestQueue[0].onWait(`API Rate Limit hit. Waiting ${waitSecs}s for cooldown...`);
                    }
                    await new Promise(r => setTimeout(r, 1000));
                    continue;
                }

                // We have a key!
                this.keyIndex = (bestIdx + 1) % keys.length; // Advance wheel
                const key = keys[bestIdx];
                const activeCount = (this.activeRequestsPerKey.get(bestIdx) || 0) + 1;
                this.activeRequestsPerKey.set(bestIdx, activeCount);

                const req = this.requestQueue.shift();
                if (!req) {
                    this.activeRequestsPerKey.set(bestIdx, activeCount - 1);
                    continue;
                }

                // Execute the request asynchronously without blocking the loop from dispatching others!
                // We wrap it so we can decrement the active counter when done.
                this.dispatch(req, key, bestIdx);
                
                // Small stagger between request dispatches to avoid hitting global endpoints at the exact same ms
                await new Promise(r => setTimeout(r, 100));
            }
        } finally {
            this.isProcessingQueue = false;
        }
    }

    private async dispatch(req: QueuedRequest, key: string, idx: number) {
        try {
            const result = await req.execute(key, idx);
            req.resolve(result);
        } catch (err: any) {
            req.reject(err);
        } finally {
            const activeCount = (this.activeRequestsPerKey.get(idx) || 1) - 1;
            this.activeRequestsPerKey.set(idx, activeCount);
            // Trigger processing again in case requests were waiting on a free slot
            this.processQueue();
        }
    }

    public markKeyCooldown(idx: number, retryAfterSeconds: number) {
        this.keyCooldowns.set(idx, Date.now() + retryAfterSeconds * 1000);
    }
    
    public markKeyError(idx: number, cooldownSeconds: number = 86400) {
        this.keyCooldowns.set(idx, Date.now() + cooldownSeconds * 1000);
    }

    public getKeyStatuses(): KeyStatus[] {
        const keys = this.loadKeys();
        const now = Date.now();
        return keys.map((_, idx) => {
            const until = this.keyCooldowns.get(idx) || 0;
            return { idx, status: until > now ? 'limited' : 'ok', cooldownMs: Math.max(0, until - now) } as KeyStatus;
        });
    }
}
