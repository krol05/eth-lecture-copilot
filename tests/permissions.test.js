/**
 * lib/permissions.js — turning provider URLs into the narrowest possible
 * Chrome host grant, so an install stops warning about "all websites".
 */
const {
  originPattern, providerPattern, hostLabel,
  hasPermission, requestPermission, EMBEDDING_ORIGINS
} = require('../lib/permissions.js');

describe('originPattern', () => {
  test('keeps scheme and host, drops path and query', () => {
    expect(originPattern('https://api.groq.com/openai/v1')).toBe('https://api.groq.com/*');
    expect(originPattern('https://api.openai.com/v1?x=1')).toBe('https://api.openai.com/*');
  });

  test('drops the port, because match patterns cannot carry one', () => {
    // One grant then covers Ollama on 11434, LM Studio on 1234, and the rest
    expect(originPattern('http://localhost:11434/v1')).toBe('http://localhost/*');
    expect(originPattern('http://localhost:1234/v1')).toBe('http://localhost/*');
    expect(originPattern('http://127.0.0.1:8080/v1')).toBe('http://127.0.0.1/*');
  });

  test('refuses anything that is not http(s)', () => {
    expect(originPattern('file:///etc/passwd')).toBeNull();
    expect(originPattern('chrome-extension://abc/x')).toBeNull();
    expect(originPattern('not a url')).toBeNull();
    expect(originPattern('')).toBeNull();
    expect(originPattern(null)).toBeNull();
  });

  test('every catalog provider resolves to a single-host pattern', () => {
    const { Catalog } = require('../lib/providers/catalog.js');
    for (const provider of Catalog.list()) {
      if (!provider.base) continue;
      const pattern = providerPattern(provider);
      expect(pattern).toMatch(/^https?:\/\/[^/*]+\/\*$/);
      // Never a wildcard host — the whole point is one prompt, one site
      expect(pattern).not.toContain('*.');
      expect(pattern.startsWith('https://*') || pattern.startsWith('http://*')).toBe(false);
    }
  });
});

describe('hostLabel', () => {
  test('reads as a hostname for the user', () => {
    expect(hostLabel('https://api.groq.com/*')).toBe('api.groq.com');
    expect(hostLabel('http://localhost/*')).toBe('localhost');
  });
});

describe('the embedding model download is its own grant', () => {
  test('semantic search needs huggingface.co and nothing else', () => {
    expect(EMBEDDING_ORIGINS).toEqual(['https://huggingface.co/*']);
  });
});

describe('behaviour without the permissions API (tests, older browsers)', () => {
  test('has() assumes access rather than blocking every request', async () => {
    await expect(hasPermission('https://api.groq.com/*')).resolves.toBe(true);
  });

  test('request() reports it is unsupported instead of throwing', async () => {
    await expect(requestPermission('https://api.groq.com/*'))
      .resolves.toEqual({ granted: false, reason: 'unsupported' });
  });

  test('an empty request is a no-op success', async () => {
    await expect(requestPermission([])).resolves.toEqual({ granted: true });
  });
});

describe('with a stubbed chrome.permissions', () => {
  const origChrome = global.chrome;
  afterEach(() => { global.chrome = origChrome; });

  test('has() reflects what Chrome reports', async () => {
    global.chrome = {
      runtime: { lastError: null },
      permissions: { contains: (_opts, cb) => cb(true) }
    };
    await expect(hasPermission('https://api.groq.com/*')).resolves.toBe(true);

    global.chrome.permissions.contains = (_opts, cb) => cb(false);
    await expect(hasPermission('https://api.groq.com/*')).resolves.toBe(false);
  });

  test('a refused prompt is reported as denied, not as an error', async () => {
    global.chrome = {
      runtime: { lastError: null },
      permissions: { request: (_opts, cb) => cb(false) }
    };
    await expect(requestPermission('https://api.groq.com/*'))
      .resolves.toEqual({ granted: false, reason: 'denied' });
  });

  test('asking outside a user gesture is distinguishable from a refusal', async () => {
    // The UI must say different things: "you declined" vs "ask from the popup"
    global.chrome = {
      runtime: { lastError: { message: 'This function must be called during a user gesture' } },
      permissions: { request: (_opts, cb) => cb(false) }
    };
    const result = await requestPermission('https://api.groq.com/*');
    expect(result.granted).toBe(false);
    expect(result.reason).toBe('gesture');
  });
});
