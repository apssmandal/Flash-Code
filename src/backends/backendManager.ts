import * as vscode from 'vscode';
import { sendToOllama, isOllamaAvailable } from './ollama';
import { sendToGemini } from './gemini';
import { Msg, GenConfig, KeyStatusCb } from './types';

/**
 * Client-side request throttle. Sized to the number of configured keys so a
 * long autonomous run paces itself under the free-tier ~15 RPM/key limit
 * instead of bursting and 429-ing.
 */
let queue: Promise<any> = Promise.resolve();
let timestamps: number[] = [];

function budgetPerMin(): number {
    const c = vscode.workspace.getConfiguration('flashCode');
    const keys = (c.get<string[]>('gemini.apiKeys') || []).filter(Boolean);
    const n = Math.max(1, keys.length);
    const globalLimit = c.get<number>('rateLimit.requestsPerMinute') || 15;
    return Math.max(1, Math.min(globalLimit - 1, n * 15 - 2));
}

async function throttle(): Promise<void> {
    const now = Date.now();
    timestamps = timestamps.filter(t => now - t < 60000);
    if (timestamps.length >= budgetPerMin()) {
        const wait = 60000 - (now - timestamps[0]) + 50;
        await new Promise(res => setTimeout(res, wait));
    }
    timestamps.push(Date.now());
}

export interface SendOpts {
    images?: { mime: string; data: string }[];
    config?: GenConfig;
    onKeyStatus?: KeyStatusCb;
}

export async function sendMessage(
    messages: Msg[],
    onChunk: (t: string) => void,
    opts: SendOpts = {},
    retries = 5
): Promise<{ text: string; backend: string }> {
    // Serialize + throttle all backend calls.
    const run = queue.then(async () => {
        let attempt = 0;
        while (attempt < retries) {
            const c = vscode.workspace.getConfiguration('flashCode');
            let be = c.get<string>('defaultBackend') || 'gemini';
            const { images, config, onKeyStatus } = opts;
            try {
                if (be === 'ollama' && !(await isOllamaAvailable())) {
                    const keys = c.get<string[]>('gemini.apiKeys') || []; const single = c.get<string>('gemini.apiKey') || '';
                    if (keys.length > 0 || single) { vscode.window.showWarningMessage('Ollama offline, using Gemini.'); be = 'gemini'; }
                    else throw new Error('Ollama offline, no Gemini key.');
                }
                if (be === 'ollama' && images && images.length > 0) { vscode.window.showWarningMessage('Images need Gemini.'); be = 'gemini'; }
                if (be === 'gemini') await throttle();
                const text = be === 'ollama'
                    ? await sendToOllama(messages, onChunk, config)
                    : await sendToGemini(messages, onChunk, images, config, onKeyStatus);
                return { text, backend: be };
            } catch (e: any) {
                attempt++;
                const isRateLimit = /rate-limited|rate limit|429|too many requests/i.test(e.message);
                const isOverload = /503|500|busy|overloaded|high demand|unavailable/i.test(e.message);
                
                if ((isRateLimit || isOverload) && attempt < retries) {
                    const waitTime = isRateLimit ? 10000 : 3000 * attempt;
                    vscode.window.showWarningMessage(`API request failed: ${e.message}. Retrying attempt ${attempt}/${retries} in ${waitTime/1000}s...`);
                    await new Promise(res => setTimeout(res, waitTime));
                    continue;
                }
                throw new Error('[' + be + '] ' + e.message);
            }
        }
        throw new Error('Maximum request retries reached.');
    });
    // keep the chain alive even if this call rejects
    queue = run.catch(() => {});
    return run;
}
