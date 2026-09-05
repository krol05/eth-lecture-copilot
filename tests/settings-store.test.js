'use strict';

const {
  ROAMING_KEYS, LOCAL_ONLY_KEYS, MIGRATION_FLAG, SYNC_SAFE_ITEM,
  fitsInSync, partitionSettings, planMigration, resolveSettings, estimateSyncBytes
} = require('../lib/settings-store.js');

describe('what is allowed to leave this machine', () => {
  test('no secret is ever on the roaming list', () => {
    // The whole point of the split. If someone adds a key here, this fails.
    for (const secret of Object.keys(LOCAL_ONLY_KEYS)) {
      expect(ROAMING_KEYS).not.toContain(secret);
    }
  });

  test('an API key stays local even though the provider roams', () => {
    const { roaming, local } = partitionSettings({
      provider: 'anthropic', model: 'claude-opus-5', apiKey: 'sk-ant-secret'
    });
    expect(roaming).toEqual({ provider: 'anthropic', model: 'claude-opus-5' });
    expect(local).toEqual({ apiKey: 'sk-ant-secret' });
  });

  test('provider overrides stay local, since they can carry auth headers', () => {
    const { roaming, local } = partitionSettings({
      providerOverrides: { openai: { headers: { Authorization: 'Bearer x' } } }
    });
    expect(roaming).toEqual({});
    expect(local.providerOverrides).toBeDefined();
  });

  test('the history never goes near sync', () => {
    const { roaming } = partitionSettings({ guideHistory: [{ lectureUrl: '/a' }] });
    expect(roaming).toEqual({});
  });

  test('anything unrecognised stays local rather than roaming by default', () => {
    const { roaming, local } = partitionSettings({ somethingNew: 1 });
    expect(roaming).toEqual({});
    expect(local).toEqual({ somethingNew: 1 });
  });
});

describe('staying inside what Chrome accepts', () => {
  test('a normal setting fits', () => {
    expect(fitsInSync('uiSettings', { theme: 'dark' })).toBe(true);
  });

  test('an oversized setting does not', () => {
    expect(fitsInSync('customPromptExtras', { guide: 'x'.repeat(SYNC_SAFE_ITEM) })).toBe(false);
  });

  test('something unserialisable is refused rather than thrown', () => {
    const circular = {};
    circular.self = circular;
    expect(fitsInSync('uiSettings', circular)).toBe(false);
  });

  test('a too-large roaming setting falls back to local and is reported', () => {
    // Chrome rejects an oversized write outright, so it must never be tried.
    const { roaming, local, tooLarge } = partitionSettings({
      customPromptExtras: { guide: 'x'.repeat(9000) }
    });
    expect(roaming).toEqual({});
    expect(local.customPromptExtras).toBeDefined();
    expect(tooLarge[0].key).toBe('customPromptExtras');
    expect(tooLarge[0].bytes).toBeGreaterThan(SYNC_SAFE_ITEM);
  });

  test('undefined values are skipped entirely', () => {
    const { roaming, local } = partitionSettings({ provider: undefined, apiKey: undefined });
    expect(roaming).toEqual({});
    expect(local).toEqual({});
  });

  test('estimateSyncBytes adds up what would be written', () => {
    expect(estimateSyncBytes({ a: 'xx' })).toBe('a"xx"'.length);
    expect(estimateSyncBytes(null)).toBe(0);
  });
});

describe('the one-time migration', () => {
  const local = { uiSettings: { theme: 'dark' }, provider: 'openai', apiKey: 'sk-secret' };

  test('first run copies the roaming settings up and stamps the flag', () => {
    const plan = planMigration(local, {});
    expect(plan.migrate).toBe(true);
    expect(plan.writes.uiSettings).toEqual({ theme: 'dark' });
    expect(plan.writes.provider).toBe('openai');
    expect(plan.writes.apiKey).toBeUndefined();
    expect(Date.parse(plan.writes[MIGRATION_FLAG])).not.toBeNaN();
  });

  test('it runs once, so a later local change is not overwritten by re-migrating', () => {
    const plan = planMigration(local, { [MIGRATION_FLAG]: '2026-01-01T00:00:00Z' });
    expect(plan.migrate).toBe(false);
    expect(plan.writes).toEqual({});
  });

  test('nothing to copy is not a migration', () => {
    expect(planMigration({ apiKey: 'sk' }, {}).migrate).toBe(false);
    expect(planMigration({}, {}).migrate).toBe(false);
  });
});

describe('reading settings back', () => {
  test('a synced preference wins over the local copy', () => {
    const merged = resolveSettings(
      { uiSettings: { theme: 'light' }, apiKey: 'sk-local' },
      { uiSettings: { theme: 'dark-blue' } }
    );
    expect(merged.uiSettings).toEqual({ theme: 'dark-blue' });
  });

  test('this machine keeps its own key regardless of what sync holds', () => {
    const merged = resolveSettings({ apiKey: 'sk-local' }, { apiKey: 'sk-from-another-machine' });
    expect(merged.apiKey).toBe('sk-local');
  });

  test('a secret that somehow reached sync is not read back out', () => {
    const merged = resolveSettings({}, { apiKey: 'sk-leaked', providerOverrides: { x: 1 } });
    expect(merged.apiKey).toBeUndefined();
    expect(merged.providerOverrides).toBeUndefined();
  });

  test('a key that has never synced keeps whatever this machine had', () => {
    const merged = resolveSettings({ provider: 'groq', model: 'llama' }, {});
    expect(merged).toMatchObject({ provider: 'groq', model: 'llama' });
  });

  test('empty inputs give an empty result rather than throwing', () => {
    expect(resolveSettings(null, null)).toEqual({});
  });
});
