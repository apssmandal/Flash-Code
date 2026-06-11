/**
 * Secure API-key storage backed by VS Code SecretStorage.
 *
 * Keys never live in settings.json. Because the key pool needs a *synchronous*
 * `getKeys()` on its hot path, we hydrate an in-memory cache on activation and
 * keep it in sync on every write. A one-time migration lifts any legacy
 * plaintext config values into SecretStorage and then blanks the config.
 */

import * as vscode from 'vscode';
import { createLogger } from './core/logger';

const log = createLogger('secrets');

/** Providers that authenticate with one or more API keys. */
export type KeyedProvider = 'gemini' | 'anthropic' | 'openai' | 'openrouter' | 'groq' | 'deepseek' | 'nvidia';

const SECRET_KEY = (p: string) => `flashCode.keys.${p}`;
const MIGRATION_FLAG = 'flashCode.secrets.migrated.v1';

export class SecretStore {
  private cache = new Map<string, string[]>();

  constructor(private readonly secrets: vscode.SecretStorage) {}

  /** Hydrate the cache from SecretStorage. Call once on activation. */
  async init(providers: readonly KeyedProvider[]): Promise<void> {
    for (const p of providers) {
      try {
        const raw = await this.secrets.get(SECRET_KEY(p));
        this.cache.set(p, raw ? this.parse(raw) : []);
      } catch (e: any) {
        log.warn(`failed to load keys for ${p}: ${e?.message}`);
        this.cache.set(p, []);
      }
    }
  }

  /** Synchronous read from the cache (used by the key pool). */
  getKeys(provider: string): string[] {
    return this.cache.get(provider) ?? [];
  }

  /** Persist keys for a provider and refresh the cache. */
  async setKeys(provider: string, keys: string[]): Promise<void> {
    const clean = keys.map((k) => k.trim()).filter(Boolean);
    this.cache.set(provider, clean);
    if (clean.length) await this.secrets.store(SECRET_KEY(provider), JSON.stringify(clean));
    else await this.secrets.delete(SECRET_KEY(provider));
  }

  hasAnyKey(provider: string): boolean {
    return this.getKeys(provider).length > 0;
  }

  private parse(raw: string): string[] {
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v.map(String) : [String(v)];
    } catch {
      return raw ? [raw] : [];
    }
  }

  /**
   * One-time migration of deprecated plaintext config keys into SecretStorage,
   * then blank the config so nothing sensitive remains in settings.json.
   */
  async migrateFromConfig(ctx: vscode.ExtensionContext): Promise<void> {
    if (ctx.globalState.get<boolean>(MIGRATION_FLAG)) return;
    const cfg = vscode.workspace.getConfiguration('flashCode');

    const geminiArr = (cfg.get<string[]>('gemini.apiKeys') ?? []).filter(Boolean);
    const geminiSingle = (cfg.get<string>('gemini.apiKey') ?? '').trim();
    const geminiKeys = [...geminiArr, ...(geminiSingle ? [geminiSingle] : [])];
    if (geminiKeys.length) {
      await this.setKeys('gemini', [...this.getKeys('gemini'), ...geminiKeys]);
      await safeBlank(cfg, 'gemini.apiKeys', []);
      await safeBlank(cfg, 'gemini.apiKey', '');
      log.info(`migrated ${geminiKeys.length} Gemini key(s) to SecretStorage`);
    }

    const nvidiaKey = (cfg.get<string>('nvidia.apiKey') ?? '').trim();
    if (nvidiaKey) {
      await this.setKeys('nvidia', [...this.getKeys('nvidia'), nvidiaKey]);
      await safeBlank(cfg, 'nvidia.apiKey', '');
      log.info('migrated Nvidia key to SecretStorage');
    }

    await ctx.globalState.update(MIGRATION_FLAG, true);
  }
}

async function safeBlank(cfg: vscode.WorkspaceConfiguration, key: string, empty: unknown): Promise<void> {
  // Prefer clearing the global value; fall back to writing an empty value.
  try { await cfg.update(key, undefined, vscode.ConfigurationTarget.Global); } catch { /* ignore */ }
  try { await cfg.update(key, empty, vscode.ConfigurationTarget.Global); } catch { /* ignore */ }
}
