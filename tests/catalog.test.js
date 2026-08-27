/**
 * Structural invariants for lib/providers/catalog.js — the single source of
 * truth for providers. These tests guard the catalog's contract, not its
 * exact contents: model lists may be refreshed freely, but the shape and the
 * project-level rules (no max-token tables, no retired IDs, valid adapters)
 * must hold.
 */
const { Catalog } = require('../lib/providers/catalog.js');

const ALL = Catalog.list();
const FIRST_CLASS_IDS = ['anthropic', 'openai', 'google', 'deepseek', 'openrouter'];
const ADAPTERS = ['anthropic', 'google', 'oai'];

describe('catalog structure', () => {
  test('exposes a non-empty provider list', () => {
    expect(Array.isArray(ALL)).toBe(true);
    expect(ALL.length).toBeGreaterThan(20);
  });

  test('provider ids are unique', () => {
    const ids = ALL.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('every entry has id, label, adapter, kind, base and a models array', () => {
    for (const p of ALL) {
      expect(typeof p.id).toBe('string');
      expect(p.id.length).toBeGreaterThan(0);
      expect(typeof p.label).toBe('string');
      expect(ADAPTERS).toContain(p.adapter);
      expect(['first', 'preset', 'local']).toContain(p.kind);
      expect(typeof p.base).toBe('string');
      expect(Array.isArray(p.models)).toBe(true);
    }
  });

  test('base URLs are https, except locals which are http://localhost', () => {
    for (const p of ALL) {
      if (p.kind === 'local') {
        expect(p.base).toMatch(/^http:\/\/localhost:\d+/);
      } else {
        expect(p.base).toMatch(/^https:\/\//);
      }
      expect(p.base).not.toMatch(/\/$/); // no trailing slash — adapters join paths
    }
  });

  test('model ids are unique within each provider and every model has a label', () => {
    for (const p of ALL) {
      const ids = p.models.map(m => m.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const m of p.models) {
        expect(typeof m.id).toBe('string');
        expect(typeof m.label).toBe('string');
      }
    }
  });

  test('defaultModel resolves to a listed model for every non-local provider', () => {
    for (const p of ALL) {
      if (p.kind === 'local') continue;
      const def = Catalog.defaultModel(p.id);
      expect(def).toBeTruthy();
      expect(p.models.map(m => m.id)).toContain(def);
    }
  });

  test('catalog is pure JSON-serializable data (no functions in entries)', () => {
    expect(() => JSON.stringify(ALL)).not.toThrow();
    expect(JSON.parse(JSON.stringify(ALL))).toEqual(ALL);
  });
});

describe('catalog project rules', () => {
  test('first-class providers are exactly the agreed five', () => {
    const firsts = ALL.filter(p => p.kind === 'first').map(p => p.id);
    expect(firsts.sort()).toEqual([...FIRST_CLASS_IDS].sort());
  });

  test('presets and locals all run on the generic oai adapter', () => {
    for (const p of ALL) {
      if (p.kind !== 'first') expect(p.adapter).toBe('oai');
    }
  });

  test('local providers need no key and have runtime-discovered models', () => {
    for (const p of ALL.filter(p => p.kind === 'local')) {
      expect(p.id).toMatch(/^local_/);
      expect(p.noAuth).toBe(true);
      expect(p.models).toEqual([]);
      expect(p.keyLink).toBeUndefined();
    }
  });

  test('cloud providers carry keyLink and keyHint for the key UI', () => {
    for (const p of ALL.filter(p => p.kind !== 'local')) {
      expect(p.keyLink).toMatch(/^https:\/\//);
      expect(typeof p.keyHint).toBe('string');
    }
  });

  test('no max-token tables anywhere (removed by design, never reintroduce)', () => {
    const json = JSON.stringify(ALL).toLowerCase();
    expect(json).not.toContain('maxtokens');
    expect(json).not.toContain('max_tokens');
    expect(json).not.toContain('maxoutputtokens');
  });

  test('every provider offers free-text model input (lists are never gates)', () => {
    for (const p of ALL) expect(p.customModel).toBe(true);
  });

  test('still-served legacy models stay listed (backwards compatibility)', () => {
    // These are confirmed active per docs/providers/*.md + live OpenRouter
    // /models (2026-08-23). Removing them from the catalog breaks users on
    // older-model workflows even though the APIs still serve them.
    const anthropic = Catalog.get('anthropic').models.map(m => m.id);
    for (const id of ['claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-sonnet-4-5']) {
      expect(anthropic).toContain(id);
    }
    const openai = Catalog.get('openai').models.map(m => m.id);
    for (const id of ['gpt-5.5', 'gpt-5.4', 'gpt-5.1', 'gpt-5', 'gpt-4o', 'o4-mini']) {
      expect(openai).toContain(id);
    }
    const google = Catalog.get('google').models.map(m => m.id);
    for (const id of ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite']) {
      expect(google).toContain(id);
    }
  });

  test('no retired model ids ship as defaults', () => {
    // Verified retired per docs/providers/*.md (2026-08-23)
    const retired = [
      'deepseek-chat', 'deepseek-reasoner',            // retired 2026-07-24
      'gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-2.0-flash', // shut down
      'claude-3-5-sonnet-20241022', 'claude-3-haiku-20240307',  // retired
      'gpt-3.5-turbo', 'gpt-4-turbo'                   // shutdown 2026-10-23
    ];
    const allModelIds = ALL.flatMap(p => p.models.map(m => m.id));
    for (const dead of retired) {
      expect(allModelIds).not.toContain(dead);
    }
  });

  test('lookups behave: get() finds every listed id, unknown ids return undefined', () => {
    for (const p of ALL) expect(Catalog.get(p.id)).toBe(p);
    expect(Catalog.get('nope_not_a_provider')).toBeUndefined();
    expect(Catalog.defaultModel('nope_not_a_provider')).toBe('');
  });
});
