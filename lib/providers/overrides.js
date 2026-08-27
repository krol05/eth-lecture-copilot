/**
 * lib/providers/overrides.js
 * User-editable provider layer (M3): merges the static catalog with
 * user overrides and fully custom providers. Pure — storage objects are
 * passed in, so this runs identically in background, UI pages, and tests.
 *
 * chrome.storage.local schemas (API keys live elsewhere and NEVER sync):
 *
 *   providerOverrides: {                     // per catalog provider id
 *     [id]: {
 *       baseUrl?:      string               // replaces the catalog base URL
 *       headers?:      {name: value}        // extra headers on every request
 *       models?:       [{id, label?}]       // extra models, shown first
 *       defaultModel?: string
 *       hidden?:       boolean              // hide from pickers (never deletes)
 *     }
 *   }
 *
 *   customProviders: {                       // user-created providers
 *     [id]: {                                // id must start with "custom_"
 *       label:         string
 *       adapter?:      'oai'|'anthropic'|'google'   (default 'oai')
 *       baseUrl:       string
 *       headers?:      {name: value}
 *       models?:       [{id, label?}]
 *       defaultModel?: string
 *       noAuth?:       boolean               // key optional, not forbidden
 *     }
 *   }
 *
 * Precedence: override field > catalog field. Model lists merge additively
 * (override models first, catalog models kept) — never subtraction.
 */
(function (root, factory) {
  const api = factory(
    (typeof module !== 'undefined' && typeof require === 'function')
      ? require('./catalog.js').Catalog
      : (root && root.Catalog)
  );
  if (typeof module !== 'undefined') module.exports = api;
  if (root) Object.assign(root, api);
})(typeof self !== 'undefined' ? self : this, function (Catalog) {

  const ADAPTERS = ['oai', 'anthropic', 'google'];

  /**
   * Normalize a user-entered OpenAI-compatible base URL.
   * Returns the cleaned URL, or null when it can't be a valid base.
   * Tolerates the classic paste mistakes: trailing slashes and a pasted
   * full endpoint path (".../chat/completions").
   */
  function normalizeOAIBase(url) {
    let s = String(url || '').trim();
    if (!s) return null;
    if (!/^https?:\/\//i.test(s)) return null;
    s = s.replace(/\/+$/, '');
    s = s.replace(/\/chat\/completions$/i, '');
    s = s.replace(/\/+$/, '');
    try { new URL(s); } catch { return null; }
    return s;
  }

  function normalizeModels(models) {
    if (!Array.isArray(models)) return [];
    return models
      .map(m => typeof m === 'string' ? { id: m, label: m } : m)
      .filter(m => m && typeof m.id === 'string' && m.id)
      .map(m => ({ id: m.id, label: m.label || m.id }));
  }

  function mergeModels(overrideModels, baseModels) {
    const merged = [...normalizeModels(overrideModels)];
    const seen = new Set(merged.map(m => m.id));
    for (const m of normalizeModels(baseModels)) {
      if (!seen.has(m.id)) { seen.add(m.id); merged.push(m); }
    }
    return merged;
  }

  function buildCustom(id, spec) {
    if (!spec || typeof spec !== 'object') return null;
    const base = normalizeOAIBase(spec.baseUrl);
    if (!base) return null;
    return {
      id,
      label: spec.label || id.replace(/^custom_/, ''),
      adapter: ADAPTERS.includes(spec.adapter) ? spec.adapter : 'oai',
      kind: 'custom',
      base,
      headers: spec.headers && typeof spec.headers === 'object' ? spec.headers : undefined,
      models: normalizeModels(spec.models),
      defaultModel: spec.defaultModel || normalizeModels(spec.models)[0]?.id || '',
      noAuth: !!spec.noAuth,
      customModel: true
    };
  }

  /**
   * Resolve a provider id to its effective config.
   * store = { providerOverrides?, customProviders? } (both optional).
   * Returns undefined for unknown ids.
   */
  function resolveProvider(id, store = {}) {
    const overrides = store.providerOverrides || {};
    const customs = store.customProviders || {};

    if (String(id).startsWith('custom_')) {
      return buildCustom(id, customs[id]) || undefined;
    }

    const entry = Catalog.get(id);
    if (!entry) return undefined;
    const o = overrides[id];
    if (!o || typeof o !== 'object') return entry;

    const resolved = Object.assign({}, entry);
    const base = o.baseUrl ? normalizeOAIBase(o.baseUrl) : null;
    if (base) resolved.base = base;
    if (o.headers && typeof o.headers === 'object' && Object.keys(o.headers).length) {
      resolved.headers = Object.assign({}, entry.headers, o.headers);
    }
    if (Array.isArray(o.models) && o.models.length) {
      resolved.models = mergeModels(o.models, entry.models);
    }
    if (o.defaultModel) resolved.defaultModel = o.defaultModel;
    if (o.baseUrl && !base) resolved.invalidBaseUrl = true; // surfaced by the UI
    return resolved;
  }

  /**
   * Everything the pickers should list: catalog (minus hidden) + customs,
   * each fully resolved. Hidden providers stay resolvable by id — hiding is
   * cosmetic, never destructive.
   */
  function listResolvedProviders(store = {}) {
    const overrides = store.providerOverrides || {};
    const customs = store.customProviders || {};
    const out = [];
    for (const p of Catalog.list()) {
      if (overrides[p.id]?.hidden) continue;
      out.push(resolveProvider(p.id, store));
    }
    for (const id of Object.keys(customs)) {
      if (!String(id).startsWith('custom_')) continue;
      const built = buildCustom(id, customs[id]);
      if (built) out.push(built);
    }
    return out;
  }

  return { resolveProvider, listResolvedProviders, normalizeOAIBase };
});
