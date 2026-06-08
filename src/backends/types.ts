export interface Msg { role: 'system' | 'user' | 'assistant'; content: string; attachments?: any[]; }
export interface GenConfig { maxOutputTokens: number; temperature: number; }
export interface KeyStatus { idx: number; status: 'ok' | 'limited' | 'error'; cooldownMs: number; }
export type KeyStatusCb = (s: KeyStatus) => void;

export const EFFORT: Record<string, GenConfig> = {
    low:    { maxOutputTokens: 8192,  temperature: 0.5 },
    medium: { maxOutputTokens: 32768, temperature: 0.7 },
    high:   { maxOutputTokens: 65536, temperature: 0.7 },
    xhigh:  { maxOutputTokens: 65536, temperature: 0.85 },
    max:    { maxOutputTokens: 65536, temperature: 1.0 },
};
