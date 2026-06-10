import * as vscode from 'vscode';
import { sendToOllama, isOllamaAvailable } from './ollama';
import { sendToGemini } from './gemini';
import { Msg, GenConfig, KeyStatusCb } from './types';

export interface SendOpts {
    images?: { mime: string; data: string }[];
    config?: GenConfig;
    onKeyStatus?: KeyStatusCb;
    onStatus?: (msg: string) => void;
    signal?: AbortSignal;
}

export async function sendMessage(
    messages: Msg[],
    onChunk: (t: string) => void,
    opts: SendOpts = {},
    retries = 5
): Promise<{ text: string; backend: string; finishReason?: string }> {
    let attempt = 0;
    while (attempt < retries) {
        if (opts.signal?.aborted) throw new Error('Cancelled');
        const c = vscode.workspace.getConfiguration('flashCode');
        let be = c.get<string>('defaultBackend') || 'gemini';
        const { images, config, onKeyStatus, onStatus, signal } = opts;
        try {
            if (be === 'ollama' && !(await isOllamaAvailable())) {
                const keys = c.get<string[]>('gemini.apiKeys') || []; const single = c.get<string>('gemini.apiKey') || '';
                if (keys.length > 0 || single) { vscode.window.showWarningMessage('Ollama offline, using Gemini.'); be = 'gemini'; }
                else throw new Error('Ollama offline, no Gemini key.');
            }
            if (be === 'ollama' && images && images.length > 0) { vscode.window.showWarningMessage('Images need Gemini.'); be = 'gemini'; }
            
            if (be === 'ollama') {
                const text = await sendToOllama(messages, onChunk, config); // Ollama doesn't use signal yet but could
                return { text, backend: be };
            } else {
                const res = await sendToGemini(messages, onChunk, images, config, onKeyStatus, onStatus, undefined, 0, signal);
                return { text: res.text, finishReason: res.finishReason, backend: be };
            }
        } catch (e: any) {
            if (opts.signal?.aborted || e.name === 'AbortError') throw new Error('Cancelled');
            attempt++;
            const isRateLimit = /rate-limited|rate limit|429|too many requests/i.test(e.message);
            const isOverload = /503|500|busy|overloaded|high demand|unavailable/i.test(e.message);
            
            if ((isRateLimit || isOverload) && attempt < retries) {
                const waitTime = isRateLimit ? 10000 : 3000 * attempt;
                vscode.window.showWarningMessage(`API request failed: ${e.message}. Retrying attempt ${attempt}/${retries} in ${waitTime/1000}s...`);
                await new Promise(res => {
                    const timer = setTimeout(res, waitTime);
                    if (opts.signal) opts.signal.addEventListener('abort', () => { clearTimeout(timer); res(undefined); });
                });
                continue;
            }
            throw new Error('[' + be + '] ' + e.message);
        }
    }
    throw new Error('Maximum request retries reached.');
}
