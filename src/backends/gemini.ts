import * as vscode from 'vscode';
import { Msg, GenConfig, KeyStatus, KeyStatusCb } from './types';

import { TaskDispatcher } from '../taskOrchestrator';

export function getKeyStatuses(): KeyStatus[] {
    return TaskDispatcher.getInstance().getKeyStatuses();
}

export async function sendToGemini(
    messages: Msg[],
    onChunk: (t: string) => void,
    images?: { mime: string; data: string }[],
    config?: GenConfig,
    onKeyStatus?: KeyStatusCb,
    onStatus?: (msg: string) => void,
    attemptedIndices: Set<number> = new Set(),
    _attempt = 0,
    signal?: AbortSignal
): Promise<{ text: string; finishReason?: string }> {
    const cfg = vscode.workspace.getConfiguration('flashCode');
    const model = cfg.get<string>('gemini.model') || 'gemini-2.5-flash';

    return TaskDispatcher.getInstance().enqueueRequest(0, async (key: string, idx: number) => {
        attemptedIndices.add(idx);
        
        const sys = messages.find(m => m.role === 'system')?.content || '';
        const filtered = messages.filter(m => m.role !== 'system');
        const contents = filtered.map((m, i) => {
            const parts: any[] = [{ text: m.content }];
            if (m.role === 'user' && images && images.length > 0 && i === filtered.length - 1) {
                for (const img of images) {
                    parts.push({ inline_data: { mime_type: img.mime || 'image/png', data: img.data.replace(/^data:[^;]+;base64,/, '') } });
                }
            }
            return { role: m.role === 'assistant' ? 'model' : 'user', parts };
        });
        const gc = config || { temperature: 0.7, maxOutputTokens: 65536 };
        const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':streamGenerateContent?alt=sse&key=' + key;
        
        const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents, systemInstruction: sys ? { parts: [{ text: sys }] } : undefined, generationConfig: { temperature: gc.temperature, maxOutputTokens: gc.maxOutputTokens } }),
            signal
        });

        if (r.status === 429) {
            const retryAfter = parseInt(r.headers.get('retry-after') || '60', 10);
            TaskDispatcher.getInstance().markKeyCooldown(idx, retryAfter);
            onKeyStatus?.({ idx, status: 'limited', cooldownMs: retryAfter * 1000 });
            
            // Retry via enqueue (recursive call handles it by picking a fresh key)
            return sendToGemini(messages, onChunk, images, config, onKeyStatus, onStatus, attemptedIndices, _attempt);
        }
        if (r.status === 503 || r.status === 500) {
            if (_attempt < 3) {
                await new Promise(res => setTimeout(res, 1500 * (_attempt + 1)));
                return sendToGemini(messages, onChunk, images, config, onKeyStatus, onStatus, attemptedIndices, _attempt + 1);
            }
            const e = await r.text(); throw new Error('Gemini ' + r.status + ': ' + e);
        }
        if (r.status === 401 || r.status === 403) {
            TaskDispatcher.getInstance().markKeyError(idx, 24 * 3600);
            onKeyStatus?.({ idx, status: 'error', cooldownMs: 24 * 3600 * 1000 });
            return sendToGemini(messages, onChunk, images, config, onKeyStatus, onStatus, attemptedIndices, _attempt);
        }
        if (!r.ok) { const e = await r.text(); onKeyStatus?.({ idx, status: 'error', cooldownMs: 0 }); throw new Error('Gemini ' + r.status + ': ' + e); }

        onKeyStatus?.({ idx, status: 'ok', cooldownMs: 0 });
        const reader = r.body!.getReader(); const dec = new TextDecoder(); let full = ''; let finishReason: string | undefined;
        let buffer = '';
        while (true) {
            const { done, value } = await reader.read(); if (done) break;
            buffer += dec.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const ln of lines) {
                if (ln.startsWith('data: ')) {
                    try { 
                        const j = JSON.parse(ln.slice(6)); 
                        const part = j.candidates?.[0];
                        const t = part?.content?.parts?.[0]?.text; 
                        if (t) { full += t; onChunk(t); } 
                        if (part?.finishReason) finishReason = part.finishReason;
                    } catch {}
                }
            }
        }
        return { text: full, finishReason };
    }, onStatus);
}
