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
const { originPattern, EMBEDDING_ORIGINS, SCREENSHOT_ORIGINS } = require('../lib/permissions.js');

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
  test('no <all_urls> in the permissions granted at install', () => {
    // It IS offered as optional — tab screenshots accept nothing narrower —
    // but it is requested on first use, so an install never mentions it.
    expect(required).not.toContain('<all_urls>');
    expect(required.every(p => !p.includes('://*/'))).toBe(true);
  });

  test('only the ETH lecture hosts are required', () => {
    expect(required.sort()).toEqual([
      'https://*.tobira.ethz.ch/*',
      'https://video.ethz.ch/*'
    ]);
  });

  test('the media host wildcard covers the numbered storage nodes', () => {
    // dist.tobira.ethz.ch 302s to dist02.tobira.ethz.ch (and presumably dist03,
    // …). A redirect target needs its own grant, and cannot be checked before
    // the request — permission is verified against the URL we ask for, not the
    // one we end up at. Granting the family is the only thing that works.
    expect(reachable('https://dist.tobira.ethz.ch/*')).toBe(true);
    expect(reachable('https://dist02.tobira.ethz.ch/*')).toBe(true);
    expect(reachable('https://dist17.tobira.ethz.ch/*')).toBe(true);
  });

  test('the wildcard grants nothing outside tobira.ethz.ch', () => {
    // Checked against the REQUIRED list: optional permissions deliberately
    // include https://*/*, so "reachable" is true for everything there.
    const grantedOnInstall = t => required.some(p => covers(p, t));
    expect(grantedOnInstall('https://dist02.tobira.ethz.ch/*')).toBe(true);
    expect(grantedOnInstall('https://elsewhere.ethz.ch/*')).toBe(false);
    expect(grantedOnInstall('https://evil.example.com/*')).toBe(false);
    expect(required).not.toContain('https://*.ethz.ch/*');
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

describe('any self-hosted server can be reached, on any address', () => {
  // optional_host_permissions do NOT appear in the install warning — Chrome
  // only warns about REQUIRED permissions, and prompts for optional ones per
  // origin at the moment they are requested. So listing http://*/* here costs
  // nothing at install time and is what makes a proxy like LiteLLM usable
  // wherever the user actually runs it.
  test('loopback, by name or by address', () => {
    expect(reachable('http://localhost/*')).toBe(true);
    expect(reachable('http://127.0.0.1/*')).toBe(true);
  });

  test('a machine elsewhere on the network', () => {
    // LiteLLM, Ollama or vLLM on a desktop, a home server, or a lab box
    expect(reachable('http://192.168.1.50/*')).toBe(true);
    expect(reachable('http://10.0.0.7/*')).toBe(true);
    expect(reachable('http://my-server.local/*')).toBe(true);
  });

  test('a port never narrows what is reachable', () => {
    // Match patterns carry no port, so one grant covers every port on a host
    expect(originPattern('http://localhost:4000/v1')).toBe('http://localhost/*');
    expect(originPattern('http://192.168.1.50:8000/v1')).toBe('http://192.168.1.50/*');
  });

  test('breadth here does not leak into the install warning', () => {
    expect(required).not.toContain('http://*/*');
    expect(required).not.toContain('https://*/*');
  });
});


describe('attaching a video frame', () => {
  test('the screenshot grant is offered, but only as an optional one', () => {
    // Chrome refuses captureVisibleTab with host access to the lecture page:
    // "Either the '<all_urls>' or 'activeTab' permission is required".
    // activeTab never goes live for a sidebar injected into the page, so this
    // feature genuinely needs the broad grant — asked for on the click.
    for (const origin of SCREENSHOT_ORIGINS) {
      expect(optional).toContain(origin);
      expect(required).not.toContain(origin);
    }
  });
});
