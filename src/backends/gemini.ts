import * as vscode from 'vscode';
import { Msg, GenConfig, KeyStatus, KeyStatusCb } from './types';

let keyIndex = 0;
const keyCooldowns: Map<number, number> = new Map(); // idx -> usable-again timestamp (ms)
let lastKeys: string[] = [];

function loadKeys(): string[] {
    const cfg = vscode.workspace.getConfiguration('flashCode');
    const keys = (cfg.get<string[]>('gemini.apiKeys') || []).filter(Boolean);
    const single = cfg.get<string>('gemini.apiKey') || '';
    const all = keys.length ? keys : (single ? [single] : []);
    lastKeys = all;
    return all;
}

/** Round-robin, skipping keys that are cooling down from a 429. Excludes already-attempted keys in the current request. */
function getNextKey(attemptedIndices: Set<number> = new Set()): { key: string; idx: number } {
    const keys = loadKeys();
    if (!keys.length) throw new Error('No Gemini API key. Add keys in the sidebar ⚙ settings or flashCode.gemini.apiKeys.');
    const now = Date.now();
    
    // First pass: find a key not cooling down and not tried in this request attempt
    for (let i = 0; i < keys.length; i++) {
        const idx = (keyIndex + i) % keys.length;
        if (attemptedIndices.has(idx)) continue;
        if ((keyCooldowns.get(idx) || 0) <= now) {
            keyIndex = (idx + 1) % keys.length;
            return { key: keys[idx], idx };
        }
    }
    
    // Second pass: if all non-cooldown keys tried, look for any key not tried in this request yet
    for (let i = 0; i < keys.length; i++) {
        const idx = (keyIndex + i) % keys.length;
        if (attemptedIndices.has(idx)) continue;
        keyIndex = (idx + 1) % keys.length;
        return { key: keys[idx], idx };
    }
    
    const soonest = Math.min(...keys.map((_, i) => keyCooldowns.get(i) || 0));
    const wait = Math.max(1, Math.ceil((soonest - now) / 1000));
    throw new Error('All API keys are rate-limited. Add more keys or wait ~' + wait + 's.');
}

/** Snapshot of every configured key's health, for the settings UI. */
export function getKeyStatuses(): KeyStatus[] {
    const keys = loadKeys();
    const now = Date.now();
    return keys.map((_, idx) => {
        const until = keyCooldowns.get(idx) || 0;
        return { idx, status: until > now ? 'limited' : 'ok', cooldownMs: Math.max(0, until - now) } as KeyStatus;
    });
}

export async function sendToGemini(
    messages: Msg[],
    onChunk: (t: string) => void,
    images?: { mime: string; data: string }[],
    config?: GenConfig,
    onKeyStatus?: KeyStatusCb,
    attemptedIndices: Set<number> = new Set(),
    _attempt = 0
): Promise<string> {
    const cfg = vscode.workspace.getConfiguration('flashCode');
    const model = cfg.get<string>('gemini.model') || 'gemini-2.5-flash';
    const { key, idx } = getNextKey(attemptedIndices);
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
        body: JSON.stringify({ contents, systemInstruction: sys ? { parts: [{ text: sys }] } : undefined, generationConfig: { temperature: gc.temperature, maxOutputTokens: gc.maxOutputTokens } })
    });

    if (r.status === 429) {
        const retryAfter = parseInt(r.headers.get('retry-after') || '60', 10);
        keyCooldowns.set(idx, Date.now() + retryAfter * 1000);
        onKeyStatus?.({ idx, status: 'limited', cooldownMs: retryAfter * 1000 });
        
        const keys = loadKeys();
        if (attemptedIndices.size < keys.length) {
            // Retry on the next key in the pool
            return sendToGemini(messages, onChunk, images, config, onKeyStatus, attemptedIndices, _attempt);
        }
        throw new Error('Rate limit reached on all keys. Try again in ~' + retryAfter + 's.');
    }
    if (r.status === 503 || r.status === 500) {
        // Transient overload ("high demand"). Retry the same model a few times before giving up.
        if (_attempt < 3) {
            await new Promise(res => setTimeout(res, 1500 * (_attempt + 1)));
            return sendToGemini(messages, onChunk, images, config, onKeyStatus, attemptedIndices, _attempt + 1);
        }
        const e = await r.text(); throw new Error('Gemini ' + r.status + ': ' + e);
    }
    if (r.status === 401 || r.status === 403) {
        // Invalid or disabled key. Cool down for 24 hours (effectively disabled).
        keyCooldowns.set(idx, Date.now() + 24 * 3600 * 1000);
        onKeyStatus?.({ idx, status: 'error', cooldownMs: 24 * 3600 * 1000 });

        const keys = loadKeys();
        if (attemptedIndices.size < keys.length) {
            // Attempt key failover
            return sendToGemini(messages, onChunk, images, config, onKeyStatus, attemptedIndices, _attempt);
        }
        const e = await r.text();
        throw new Error('Gemini ' + r.status + ': ' + e);
    }
    if (!r.ok) { const e = await r.text(); onKeyStatus?.({ idx, status: 'error', cooldownMs: 0 }); throw new Error('Gemini ' + r.status + ': ' + e); }

    onKeyStatus?.({ idx, status: 'ok', cooldownMs: 0 });
    const reader = r.body!.getReader(); const dec = new TextDecoder(); let full = '';
    while (true) {
        const { done, value } = await reader.read(); if (done) break;
        for (const ln of dec.decode(value, { stream: true }).split('\n')) {
            if (ln.startsWith('data: ')) {
                try { const j = JSON.parse(ln.slice(6)); const t = j.candidates?.[0]?.content?.parts?.[0]?.text; if (t) { full += t; onChunk(t); } } catch {}
            }
        }
    }
    return full;
}
