import * as vscode from 'vscode';
import { Msg, GenConfig } from './types';

export async function sendToOllama(messages: Msg[], onChunk: (t: string) => void, config?: GenConfig): Promise<string> {
    const c = vscode.workspace.getConfiguration('flashCode');
    const url = c.get<string>('ollama.url') || 'http://localhost:11434';
    const model = c.get<string>('ollama.model') || 'qwen3-coder';
    const temp = c.get<number>('ollama.temperature') ?? 0.2;
    const numCtx = c.get<number>('ollama.numCtx') ?? 4096;
    
    const options: Record<string, any> = {
        temperature: temp,
        num_ctx: numCtx
    };
    if (config && config.maxOutputTokens) {
        options.num_predict = config.maxOutputTokens;
    }
    
    const r = await fetch(url + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages, stream: true, options }) });
    if (!r.ok) throw new Error('Ollama ' + r.status);
    const reader = r.body!.getReader(); const dec = new TextDecoder(); let full = '';
    while (true) {
        const { done, value } = await reader.read(); if (done) break;
        for (const ln of dec.decode(value, { stream: true }).split('\n').filter(l => l.trim())) {
            try { const j = JSON.parse(ln); if (j.message?.content) { full += j.message.content; onChunk(j.message.content); } } catch {}
        }
    }
    return full;
}

export async function isOllamaAvailable(): Promise<boolean> {
    try { const c = vscode.workspace.getConfiguration('flashCode'); return (await fetch((c.get<string>('ollama.url') || 'http://localhost:11434') + '/api/tags')).ok; } catch { return false; }
}
