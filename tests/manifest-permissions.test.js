/**
 * manifest.json — every host the extension contacts must be either required
 * up front or reachable through optional_host_permissions.
 *
 * This exists because dropping <all_urls> broke things that were invisible in
 * the source: the caption file is fetched from a host discovered at runtime,
 * and Anki export talks to 127.0.0.1 from the sidebar. Both had been silently
 * covered. A test is the only way to keep that from happening again.
 */
const manifest = require('../manifest.json');
const { Catalog } = require('../lib/providers/catalog.js');
const { originPattern, EMBEDDING_ORIGINS } = require('../lib/permissions.js');

/** Does a Chrome match pattern cover a concrete origin pattern? */
function covers(matchPattern, target) {
  if (matchPattern === '<all_urls>') return true;
  const m = /^(\*|https?):\/\/([^/]+)\/(.*)$/.exec(matchPattern);
  const t = /^(\*|https?):\/\/([^/]+)\/(.*)$/.exec(target);
  if (!m || !t) return false;

  const [, scheme, host] = m;
  const [, tScheme, tHost] = t;
  if (scheme !== '*' && scheme !== tScheme) return false;
  if (host === '*') return true;
  if (host.startsWith('*.')) return tHost === host.slice(2) || tHost.endsWith(`.${host.slice(2)}`);
  return host === tHost;
}

const required = manifest.host_permissions || [];
const optional = manifest.optional_host_permissions || [];
const reachable = target => [...required, ...optional].some(p => covers(p, target));

describe('the install prompt stays narrow', () => {
  test('no <all_urls> anywhere in required permissions', () => {
    expect(required).not.toContain('<all_urls>');
    expect(required.every(p => !p.includes('://*/'))).toBe(true);
  });

  test('only the ETH lecture hosts are required', () => {
    expect(required.sort()).toEqual([
      'https://dist.tobira.ethz.ch/*',
      'https://video.ethz.ch/*'
    ]);
  });

  test('no provider API is required up front', () => {
    for (const provider of Catalog.list()) {
      if (!provider.base) continue;
      const pattern = originPattern(provider.base);
      expect(required).not.toContain(pattern);
    }
  });

  test('unused API permissions are gone, and the ones we need are kept', () => {
    expect(manifest.permissions).not.toContain('scripting');
    // alarms drives the daily model refresh; unlimitedStorage keeps guides,
    // transcripts and embeddings from being capped or evicted.
    expect(manifest.permissions).toEqual(
      expect.arrayContaining(['storage', 'unlimitedStorage', 'activeTab', 'alarms'])
    );
  });
});

describe('everything the extension contacts is still reachable', () => {
  test('every provider in the catalog', () => {
    const unreachable = Catalog.list()
      .filter(p => p.base)
      .map(p => ({ id: p.id, pattern: originPattern(p.base) }))
      .filter(({ pattern }) => !pattern || !reachable(pattern));
    expect(unreachable).toEqual([]);
  });

  test('the ETH lecture pages and their caption data', () => {
    expect(reachable('https://video.ethz.ch/*')).toBe(true);
    expect(reachable('https://dist.tobira.ethz.ch/*')).toBe(true);
  });

  test('a caption file served from some other media host', () => {
    // findCaptionsUrl() falls back to any .vtt URL found in the page, so the
    // host is not knowable in advance — it must be requestable on demand.
    expect(reachable('https://some-media-host.example.com/*')).toBe(true);
  });

  test('AnkiConnect on the loopback address', () => {
    expect(reachable('http://127.0.0.1/*')).toBe(true);
  });

  test('local model servers (Ollama, LM Studio, llama.cpp …)', () => {
    expect(reachable('http://localhost/*')).toBe(true);
  });

  test('the embedding model download for semantic search', () => {
    for (const origin of EMBEDDING_ORIGINS) expect(reachable(origin)).toBe(true);
  });

  test('a user-defined custom endpoint on any https host', () => {
    expect(reachable('https://llm.somewhere.example/*')).toBe(true);
  });
});

describe('optional patterns are broad enough to cover a plain http server', () => {
  test('http is only offered for loopback, not the whole web', () => {
    // An extension that could reach any http:// site would be back to
    // warning about everything; local servers are the only http case.
    expect(optional).toContain('http://localhost/*');
    expect(optional).toContain('http://127.0.0.1/*');
    expect(optional).not.toContain('http://*/*');
    expect(reachable('http://random-site.example/*')).toBe(false);
  });
});
