import { describe, it, expect, beforeEach } from 'vitest';
import { SecretStore } from '../src/secrets';
import { makeContext, __setConfig, __resetConfig } from './mocks/vscode';

function fakeSecretStorage() {
  const map = new Map<string, string>();
  return {
    storage: { get: async (k: string) => map.get(k), store: async (k: string, v: string) => { map.set(k, v); }, delete: async (k: string) => { map.delete(k); } },
    map,
  };
}

describe('SecretStore', () => {
  beforeEach(() => __resetConfig());

  it('stores, caches, and clears keys', async () => {
    const { storage } = fakeSecretStorage();
    const store = new SecretStore(storage as any);
    await store.init(['gemini']);
    expect(store.getKeys('gemini')).toEqual([]);
    await store.setKeys('gemini', ['k1', ' k2 ', '']);
    expect(store.getKeys('gemini')).toEqual(['k1', 'k2']);
    expect(store.hasAnyKey('gemini')).toBe(true);
    await store.setKeys('gemini', []);
    expect(store.hasAnyKey('gemini')).toBe(false);
  });

  it('hydrates the cache from persisted JSON on init', async () => {
    const { storage, map } = fakeSecretStorage();
    map.set('flashCode.keys.anthropic', JSON.stringify(['abc']));
    const store = new SecretStore(storage as any);
    await store.init(['anthropic']);
    expect(store.getKeys('anthropic')).toEqual(['abc']);
  });

  it('migrates legacy plaintext config keys then blanks them, once', async () => {
    __setConfig({ 'flashCode.gemini.apiKeys': ['g1', 'g2'], 'flashCode.nvidia.apiKey': 'nv' });
    const { storage } = fakeSecretStorage();
    const ctx = makeContext();
    const store = new SecretStore(storage as any);
    await store.init(['gemini', 'nvidia']);
    await store.migrateFromConfig(ctx);
    expect(store.getKeys('gemini')).toEqual(['g1', 'g2']);
    expect(store.getKeys('nvidia')).toEqual(['nv']);
    expect(ctx.globalState.get('flashCode.secrets.migrated.v1')).toBe(true);

    // Second call is a no-op (flag set).
    await store.setKeys('gemini', ['only']);
    await store.migrateFromConfig(ctx);
    expect(store.getKeys('gemini')).toEqual(['only']);
  });
});
