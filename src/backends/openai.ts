import * as vscode from 'vscode';
import { Msg, GenConfig } from './types';

export async function sendToOpenAI(
    messages: Msg[],
    onChunk: (t: string) => void,
    images?: { mime: string; data: string }[],
    config?: GenConfig,
    signal?: AbortSignal
): Promise<string> {
    const cfg = vscode.workspace.getConfiguration('flashCode');
    const apiKey = cfg.get<string>('nvidia.apiKey') || '';
    const baseUrl = cfg.get<string>('nvidia.url') || 'https://integrate.api.nvidia.com/v1';
    const modelName = cfg.get<string>('nvidia.model') || 'nvidia/nemotron-3-ultra-550b-a55b';

    if (!apiKey) throw new Error('Nvidia/OpenAI API key not configured.');

    const oaiMessages = messages.map((m, i) => {
        if (m.role === 'user' && images && images.length > 0 && i === messages.length - 1) {
            const contentParts: any[] = [{ type: 'text', text: m.content }];
            for (const img of images) {
                const mime = img.mime || 'image/png';
                const data = img.data.startsWith('data:') ? img.data : `data:${mime};base64,${img.data}`;
                contentParts.push({ type: 'image_url', image_url: { url: data } });
            }
            return { role: m.role, content: contentParts };
        }
        return { role: m.role, content: m.content };
    });

    const temp = cfg.get<number>('nvidia.temperature') ?? 1.0;
    const maxTokens = cfg.get<number>('nvidia.maxTokens') ?? 16384;
    const stream = cfg.get<boolean>('nvidia.stream') ?? true;

    const body: any = {
        model: modelName,
        messages: oaiMessages,
        temperature: config?.temperature ?? temp,
        max_tokens: config?.maxOutputTokens ?? maxTokens,
        top_p: 0.95,
        stream: stream
    };

    // Specific nemotron parameters requested by the user
    if (modelName.includes('nemotron')) {
        body.reasoning_budget = body.max_tokens;
        body.chat_template_kwargs = { enable_thinking: true };
    }

    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body),
        signal
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`OpenAI-compatible API Error ${res.status}: ${errText}`);
    }

    if (!stream) {
        const json: any = await res.json();
        const msg = json.choices?.[0]?.message;
        let full = '';
        if (msg) {
            if (msg.reasoning_content) {
                full += msg.reasoning_content;
                onChunk(msg.reasoning_content);
            }
            if (msg.content) {
                full += msg.content;
                onChunk(msg.content);
            }
        }
        return full;
    }

    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let full = '';
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += dec.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const ln of lines) {
            const line = ln.trim();
            if (!line || line === 'data: [DONE]') continue;
            if (line.startsWith('data: ')) {
                try {
                    const j = JSON.parse(line.slice(6));
                    const delta = j.choices?.[0]?.delta;
                    if (delta) {
                        const reasoning = delta.reasoning_content;
                        if (reasoning) {
                            // Optionally handle reasoning. For now, we can append it as a thinking block if we want, or just append to text.
                            // The user requested to print it, we can format it nicely or just add it.
                            // To keep it simple, we'll stream it wrapped in <think> tags if it's the first reasoning token.
                            // Wait, the client UI might not render reasoning natively yet, so let's just append it.
                            full += reasoning;
                            onChunk(reasoning);
                        }
                        const content = delta.content;
                        if (content) {
                            full += content;
                            onChunk(content);
                        }
                    }
                } catch (e) {
                    console.error('Failed to parse SSE line', line, e);
                }
            }
        }
    }

    return full;
}
