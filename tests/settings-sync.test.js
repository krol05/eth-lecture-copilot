'use strict';

const { loadServiceWorker } = require('./helpers/service-worker.js');

/** Let the worker's storage callbacks and promise chains settle. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('settings roaming in the background worker', () => {
  test('copies preferences up on first run, and never the API key', async () => {
    const sw = loadServiceWorker({
      storage: {
        uiSettings: { theme: 'dark-blue' },
        provider: 'anthropic',
        model: 'claude-opus-5',
        apiKey: 'sk-ant-secret',
        guideHistory: [{ lectureUrl: '/a' }]
      },
      syncStorage: {}
    });
    await settle();

    expect(sw.syncStore.uiSettings).toEqual({ theme: 'dark-blue' });
    expect(sw.syncStore.provider).toBe('anthropic');
    expect(sw.syncStore.settingsRoamedAt).toBeDefined();
    // The two that must never leave the machine.
    expect(sw.syncStore.apiKey).toBeUndefined();
    expect(sw.syncStore.guideHistory).toBeUndefined();
  });

  test('a key saved later still never reaches sync', async () => {
    const sw = loadServiceWorker({ storage: {}, syncStorage: {} });
    await settle();

    // What the popup does when you press Save.
    await new Promise(r => sw.context.chrome.storage.local.set(
      { provider: 'openai', apiKey: 'sk-openai-secret' }, r
    ));
    await settle();

    expect(sw.syncStore.provider).toBe('openai');
    expect(sw.syncStore.apiKey).toBeUndefined();
    expect(Object.keys(sw.syncStore)).not.toContain('apiKey');
  });

  test('provider overrides stay local, since they can carry auth headers', async () => {
    const sw = loadServiceWorker({ storage: {}, syncStorage: {} });
    await settle();
    await new Promise(r => sw.context.chrome.storage.local.set(
      { providerOverrides: { openai: { headers: { Authorization: 'Bearer leak' } } } }, r
    ));
    await settle();
    expect(sw.syncStore.providerOverrides).toBeUndefined();
  });

  test('a preference set on another machine comes down to this one', async () => {
    const sw = loadServiceWorker({
      storage: { uiSettings: { theme: 'light' } },
      syncStorage: { settingsRoamedAt: '2026-01-01T00:00:00Z', uiSettings: { theme: 'dark' } }
    });
    await settle();
    expect(sw.store.uiSettings).toEqual({ theme: 'dark' });
  });

  test('the migration runs once, so it cannot overwrite a later local change', async () => {
    const sw = loadServiceWorker({
      storage: { provider: 'groq' },
      syncStorage: { settingsRoamedAt: '2026-01-01T00:00:00Z', provider: 'openai' }
    });
    await settle();
    // Already migrated, so sync is the authority and groq is not pushed up.
    expect(sw.syncStore.provider).toBe('openai');
    expect(sw.store.provider).toBe('openai');
  });

  test('mirroring settles instead of bouncing between the two areas', async () => {
    const sw = loadServiceWorker({ storage: {}, syncStorage: {} });
    await settle();
    let writes = 0;
    const realSet = sw.context.chrome.storage.sync.set;
    sw.context.chrome.storage.sync.set = (obj, cb) => { writes++; return realSet(obj, cb); };

    await new Promise(r => sw.context.chrome.storage.local.set({ model: 'gpt-5.5' }, r));
    await settle();
    await settle();

    // One write up, and the echo back down is recognised as already equal.
    expect(writes).toBe(1);
    expect(sw.syncStore.model).toBe('gpt-5.5');
    expect(sw.store.model).toBe('gpt-5.5');
  });

  test('an oversized preference stays local rather than being rejected', async () => {
    const sw = loadServiceWorker({ storage: {}, syncStorage: {} });
    await settle();
    const huge = { guide: 'x'.repeat(9000) };
    await new Promise(r => sw.context.chrome.storage.local.set({ customPromptExtras: huge }, r));
    await settle();

    expect(sw.store.customPromptExtras).toEqual(huge);
    expect(sw.syncStore.customPromptExtras).toBeUndefined();
  });

  test('signed out of Chrome, everything still works with no sync area', async () => {
    const sw = loadServiceWorker({ storage: { provider: 'openai' } });   // no syncStorage
    await settle();
    expect(sw.context.chrome.storage.sync).toBeUndefined();
    await new Promise(r => sw.context.chrome.storage.local.set({ model: 'x' }, r));
    await settle();
    expect(sw.store.model).toBe('x');
  });
});
