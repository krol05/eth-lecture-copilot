/**
 * lib/providers/overrides.js — merge precedence: catalog ⊕ override ⊕ custom.
 */
const { resolveProvider, listResolvedProviders, normalizeOAIBase } = require('../lib/providers/overrides.js');
const { Catalog } = require('../lib/providers/catalog.js');

describe('normalizeOAIBase', () => {
  test('cleans trailing slashes and pasted endpoint paths', () => {
    expect(normalizeOAIBase('https://api.example.com/v1/')).toBe('https://api.example.com/v1');
    expect(normalizeOAIBase('https://api.example.com/v1/chat/completions')).toBe('https://api.example.com/v1');
    expect(normalizeOAIBase('  http://localhost:11434/v1  ')).toBe('http://localhost:11434/v1');
  });

  test('rejects non-URLs and non-http schemes', () => {
    expect(normalizeOAIBase('')).toBeNull();
    expect(normalizeOAIBase('api.example.com/v1')).toBeNull();
    expect(normalizeOAIBase('ftp://example.com')).toBeNull();
    expect(normalizeOAIBase('https://')).toBeNull();
  });
});

describe('resolveProvider', () => {
  test('no override → the catalog entry itself, untouched', () => {
    expect(resolveProvider('openai', {})).toBe(Catalog.get('openai'));
    expect(resolveProvider('openai')).toBe(Catalog.get('openai'));
  });

  test('override wins on base URL and defaultModel, catalog fills the rest', () => {
    const r = resolveProvider('openai', {
      providerOverrides: { openai: { baseUrl: 'https://proxy.example.com/v1/', defaultModel: 'my-tuned-model' } }
    });
    expect(r.base).toBe('https://proxy.example.com/v1');
    expect(r.defaultModel).toBe('my-tuned-model');
    expect(r.label).toBe('OpenAI');            // untouched
    expect(r.adapter).toBe('oai');             // untouched
    expect(Catalog.get('openai').base).toBe('https://api.openai.com/v1'); // catalog never mutated
  });

  test('override models merge additively and come first — nothing removed', () => {
    const r = resolveProvider('anthropic', {
      providerOverrides: { anthropic: { models: [{ id: 'claude-internal-preview' }, 'claude-sonnet-5'] } }
    });
    const ids = r.models.map(m => m.id);
    expect(ids[0]).toBe('claude-internal-preview');
    expect(ids.filter(id => id === 'claude-sonnet-5')).toHaveLength(1); // deduped
    for (const m of Catalog.get('anthropic').models) expect(ids).toContain(m.id);
  });

  test('override headers merge on top of any entry headers', () => {
    const r = resolveProvider('openrouter', {
      providerOverrides: { openrouter: { headers: { 'X-Team': 'eth' } } }
    });
    expect(r.headers['X-Team']).toBe('eth');
  });

  test('invalid override base URL is ignored but flagged for the UI', () => {
    const r = resolveProvider('openai', { providerOverrides: { openai: { baseUrl: 'not a url' } } });
    expect(r.base).toBe('https://api.openai.com/v1');
    expect(r.invalidBaseUrl).toBe(true);
  });

  test('quirks survive overriding (adapter behavior stays correct)', () => {
    const r = resolveProvider('groq', { providerOverrides: { groq: { baseUrl: 'https://mirror.example.com/v1' } } });
    expect(r.quirks.noJsonSchemaStream).toBe(true);
  });

  test('custom providers resolve with defaults applied', () => {
    const store = {
      customProviders: {
        custom_uni: {
          label: 'ETH Cluster', baseUrl: 'https://llm.ethz.example/v1/',
          headers: { 'X-Auth-Style': 'token' },
          models: ['llama-cluster-70b'], noAuth: false
        }
      }
    };
    const r = resolveProvider('custom_uni', store);
    expect(r).toMatchObject({
      id: 'custom_uni', label: 'ETH Cluster', adapter: 'oai', kind: 'custom',
      base: 'https://llm.ethz.example/v1', noAuth: false, customModel: true,
      defaultModel: 'llama-cluster-70b'
    });
    expect(r.models).toEqual([{ id: 'llama-cluster-70b', label: 'llama-cluster-70b' }]);
  });

  test('custom provider with a non-oai adapter keeps it; bad adapter falls back to oai', () => {
    const store = { customProviders: {
      custom_a: { label: 'A', baseUrl: 'https://a.example', adapter: 'anthropic' },
      custom_b: { label: 'B', baseUrl: 'https://b.example', adapter: 'bogus' }
    } };
    expect(resolveProvider('custom_a', store).adapter).toBe('anthropic');
    expect(resolveProvider('custom_b', store).adapter).toBe('oai');
  });

  test('unknown ids and broken custom specs resolve to undefined', () => {
    expect(resolveProvider('nope', {})).toBeUndefined();
    expect(resolveProvider('custom_missing', {})).toBeUndefined();
    expect(resolveProvider('custom_bad', { customProviders: { custom_bad: { label: 'x', baseUrl: 'not-a-url' } } })).toBeUndefined();
  });
});

describe('listResolvedProviders', () => {
  test('default store → exactly the catalog', () => {
    const list = listResolvedProviders({});
    expect(list.map(p => p.id)).toEqual(Catalog.list().map(p => p.id));
  });

  test('hidden providers disappear from the list but stay resolvable', () => {
    const store = { providerOverrides: { cohere: { hidden: true } } };
    const list = listResolvedProviders(store);
    expect(list.map(p => p.id)).not.toContain('cohere');
    expect(resolveProvider('cohere', store)).toBeDefined();
  });

  test('customs are appended; ids not starting with custom_ are ignored', () => {
    const store = { customProviders: {
      custom_uni: { label: 'Uni', baseUrl: 'https://llm.example/v1' },
      evil: { label: 'nope', baseUrl: 'https://x.example' }
    } };
    const ids = listResolvedProviders(store).map(p => p.id);
    expect(ids).toContain('custom_uni');
    expect(ids).not.toContain('evil');
  });
});
