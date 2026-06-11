/**
 * Provider registry — wires each Provider from VS Code config + SecretStorage,
 * giving every keyed provider its own KeyPool (Gemini gets the multi-key array;
 * others typically a single key, same machinery). Resolves the active provider.
 */

import * as vscode from 'vscode';
import { SecretStore, KeyedProvider } from '../secrets';
import { KeyPool, KeyStatus } from './keyPool';
import { Provider } from './types';
import { GeminiProvider } from './gemini';
import { AnthropicProvider } from './anthropic';
import { OllamaProvider } from './ollama';
import { OpenAICompatibleProvider } from './openaiCompatible';

export const KEYED_PROVIDERS: readonly KeyedProvider[] = ['gemini', 'anthropic', 'openai', 'openrouter', 'groq', 'deepseek', 'nvidia'];

function cfg() { return vscode.workspace.getConfiguration('flashCode'); }
function rpm() { return cfg().get<number>('rateLimit.requestsPerMinute') ?? 15; }

export class ProviderRegistry {
  private providers = new Map<string, Provider>();
  private pools = new Map<string, KeyPool>();

  constructor(private secrets: SecretStore) {
    this.build();
  }

  private poolFor(id: KeyedProvider): KeyPool {
    const pool = new KeyPool({ getKeys: () => this.secrets.getKeys(id), rpm: rpm() });
    this.pools.set(id, pool);
    return pool;
  }

  private build() {
    const c = cfg();

    this.register(new GeminiProvider(this.poolFor('gemini'), () => c.get<string>('gemini.model') || 'gemini-2.5-flash'));
    this.register(new AnthropicProvider(this.poolFor('anthropic'), () => cfg().get<string>('anthropic.model') || 'claude-sonnet-4-6'));

    this.register(new OpenAICompatibleProvider({
      id: 'openai', label: 'OpenAI', keyPool: this.poolFor('openai'),
      baseUrl: () => cfg().get<string>('customEndpoint.url') || 'https://api.openai.com/v1',
      model: () => cfg().get<string>('openai.model') || 'gpt-4o',
      defaultModel: 'gpt-4o', models: ['gpt-4o', 'gpt-4o-mini', 'o3-mini', 'gpt-4.1'],
    }));

    this.register(new OpenAICompatibleProvider({
      id: 'openrouter', label: 'OpenRouter', keyPool: this.poolFor('openrouter'),
      baseUrl: () => 'https://openrouter.ai/api/v1',
      model: () => cfg().get<string>('openrouter.model') || 'anthropic/claude-sonnet-4-6',
      defaultModel: 'anthropic/claude-sonnet-4-6',
      models: ['anthropic/claude-sonnet-4-6', 'anthropic/claude-opus-4-8', 'openai/gpt-4o', 'google/gemini-2.5-flash', 'deepseek/deepseek-chat'],
      headers: () => ({ 'HTTP-Referer': 'https://animixer.in', 'X-Title': 'Flash Code' }),
    }));

    this.register(new OpenAICompatibleProvider({
      id: 'groq', label: 'Groq', keyPool: this.poolFor('groq'),
      baseUrl: () => 'https://api.groq.com/openai/v1',
      model: () => cfg().get<string>('groq.model') || 'llama-3.3-70b-versatile',
      defaultModel: 'llama-3.3-70b-versatile', models: ['llama-3.3-70b-versatile', 'qwen-2.5-coder-32b', 'deepseek-r1-distill-llama-70b'],
      capabilities: { vision: false },
    }));

    this.register(new OpenAICompatibleProvider({
      id: 'deepseek', label: 'DeepSeek', keyPool: this.poolFor('deepseek'),
      baseUrl: () => 'https://api.deepseek.com/v1',
      model: () => cfg().get<string>('deepseek.model') || 'deepseek-chat',
      defaultModel: 'deepseek-chat', models: ['deepseek-chat', 'deepseek-reasoner'],
      capabilities: { vision: false },
    }));

    this.register(new OpenAICompatibleProvider({
      id: 'nvidia', label: 'Nvidia', keyPool: this.poolFor('nvidia'),
      baseUrl: () => cfg().get<string>('nvidia.url') || 'https://integrate.api.nvidia.com/v1',
      model: () => cfg().get<string>('nvidia.model') || 'nvidia/nemotron-3-ultra-550b-a55b',
      defaultModel: 'nvidia/nemotron-3-ultra-550b-a55b', models: ['nvidia/nemotron-3-ultra-550b-a55b'],
    }));

    this.register(new OllamaProvider({
      url: () => cfg().get<string>('ollama.url') || 'http://localhost:11434',
      model: () => cfg().get<string>('ollama.model') || 'qwen3-coder',
      numCtx: () => cfg().get<number>('ollama.numCtx') ?? 8192,
    }));
  }

  private register(p: Provider) { this.providers.set(p.id, p); }

  list(): Provider[] { return [...this.providers.values()]; }
  get(id: string): Provider | undefined { return this.providers.get(id); }

  activeId(): string { return cfg().get<string>('provider') || 'gemini'; }

  getActive(): Provider {
    return this.providers.get(this.activeId()) ?? this.providers.get('gemini')!;
  }

  /** The configured model for the active provider (falls back to its default). */
  activeModel(): string {
    const active = this.getActive();
    return cfg().get<string>(`${active.id}.model`) || active.defaultModel();
  }

  /** User-added custom model IDs for a provider. */
  customModels(id: string): string[] {
    const obj = cfg().get<Record<string, string[]>>('customModels') || {};
    return Array.isArray(obj[id]) ? obj[id] : [];
  }

  /** Built-in + custom models for a provider (deduped). */
  modelsFor(id: string): string[] {
    const p = this.get(id);
    const builtin = p ? p.models() : [];
    return Array.from(new Set([...builtin, ...this.customModels(id)]));
  }

  /** Key statuses for the active provider (for the sidebar indicator). */
  getActiveKeyStatuses(): KeyStatus[] {
    return this.keyStatuses(this.activeId());
  }

  /** Key statuses for a specific provider. */
  keyStatuses(id: string): KeyStatus[] {
    const pool = this.pools.get(id);
    return pool ? pool.getStatuses() : [];
  }

  /** Refresh RPM/model bindings after a settings change. */
  rebuild() { this.providers.clear(); this.pools.clear(); this.build(); }
}
