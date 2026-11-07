/**
 * Which settings follow you to another computer, and which never leave this one.
 *
 * Chrome syncs `chrome.storage.sync` across the browsers you are signed into.
 * That is what you want for your theme and your prompt wording, and exactly
 * what you do not want for an API key — so the split is spelled out here
 * rather than decided at each call site.
 *
 * chrome.storage.sync is small: 100 KB total and 8 KB per item, and it rejects
 * anything larger instead of truncating. Every write goes through fitsInSync
 * first, and anything too big simply stays local.
 *
 * ─── Where anything else belongs ──────────────────────────────────────────
 *
 * The extension keeps state in four places. Which one to use is not a matter
 * of taste, and picking by habit is how the same preference ended up owned
 * twice. In order of preference:
 *
 *   chrome.storage.local   The default. Everything that survives a reload and
 *                          is not needed before the first paint: saved guides,
 *                          tool outputs, provider settings, the remembered
 *                          sidebar controls (see REMEMBERED_CONTROLS in
 *                          sidebar/session.js). Asynchronous.
 *
 *   chrome.storage.sync    Only the keys in ROAMING_KEYS below. Never a
 *                          credential, never anything that could carry one.
 *                          Mirrored by background/background.js.
 *
 *   localStorage           Only when a value is needed *synchronously*, before
 *                          asynchronous storage could possibly answer. That is
 *                          a short list and it should stay short: the theme
 *                          (set on <html> before first paint, or the sidebar
 *                          flashes the wrong colours), auto-time-follow (read
 *                          into a module variable at load and used by logic
 *                          immediately), the generation bar's collapsed state
 *                          (a self-contained module with no chrome access),
 *                          the Q&A panel's open/closed disclosure state, and
 *                          the print hand-off payloads, which cross a window
 *                          boundary. A *preference* does not belong here.
 *
 *   IndexedDB              Large binary or bulk data only — today that is the
 *                          course-script store in sidebar/scripts.js, keyed by
 *                          courseId. Nothing small belongs here.
 *
 * One value has exactly one owner. If something is already persisted, extend
 * that path rather than adding a second one beside it.
 */
(function (root) {
  'use strict';

  /** Chrome's per-item ceiling, with room left for the key name and overhead. */
  const SYNC_ITEM_LIMIT = 8192;
  const SYNC_SAFE_ITEM = 7500;
  /** Chrome's total ceiling for the whole sync area. */
  const SYNC_TOTAL_LIMIT = 102400;
  const MIGRATION_FLAG = 'settingsRoamedAt';

  /**
   * Settings worth carrying between machines.
   *
   * `provider` and `model` are here on purpose: which model you prefer is a
   * preference. The key that authorises it is not, and is never listed.
   */
  const ROAMING_KEYS = [
    'uiSettings',          // theme, font sizes
    'customPromptExtras',  // your own prompt wording
    'toolThinking',        // per-tool reasoning levels
    'summaryOptions',
    'provider',
    'model',
    'scriptStrictness',
    'obsidianVault',
    'obsidianFolder',
    'onboardingSeen'
  ];

  /**
   * Settings that must never be synced, with the reason.
   * Kept as data so the test can assert on it and a future key cannot be
   * added to the roaming list by accident.
   */
  const LOCAL_ONLY_KEYS = {
    apiKey: 'authorises spending money',
    apiKeys: 'authorises spending money',
    providerOverrides: 'may carry auth headers',
    customProviders: 'may carry auth headers',
    adapterSpecs: 'may carry auth headers',
    localBases: 'addresses on this machine only',
    guideHistory: 'far too large for sync',
    lectureIdMap: 'belongs with the history',
    currentGuide: 'per-session working state',
    currentTranscript: 'per-session working state',
    currentQaChats: 'per-session working state',
    currentQaMessages: 'per-session working state',
    currentToolOutputs: 'per-session working state',
    currentGuideToolOutputs: 'per-session working state',
    currentLectureSummary: 'per-session working state',
    currentToolAskSessions: 'per-session working state',
    modelCache: 'refetched per machine',
    errorHistory: 'about this machine'
  };

  /** Would Chrome accept this value for this key? */
  function fitsInSync(key, value) {
    if (value === undefined) return false;
    let size;
    try {
      size = new TextEncoder().encode(key + JSON.stringify(value)).length;
    } catch {
      return false;   // circular, or otherwise not serialisable
    }
    return size <= SYNC_SAFE_ITEM;
  }

  /**
   * Split a bag of settings into what may sync and what may not.
   * @returns {{roaming:object, local:object, tooLarge:Array<{key:string,bytes:number}>}}
   */
  function partitionSettings(all) {
    const roaming = {};
    const local = {};
    const tooLarge = [];

    for (const [key, value] of Object.entries(all || {})) {
      if (value === undefined) continue;
      if (!ROAMING_KEYS.includes(key)) {
        local[key] = value;
        continue;
      }
      if (fitsInSync(key, value)) {
        roaming[key] = value;
      } else {
        local[key] = value;
        let bytes;
        try { bytes = new TextEncoder().encode(key + JSON.stringify(value)).length; } catch { bytes = -1; }
        tooLarge.push({ key, bytes });
      }
    }
    return { roaming, local, tooLarge };
  }

  /**
   * What to write to sync the first time roaming is switched on.
   *
   * Runs once — the flag records when — so a later local change is never
   * overwritten by re-migrating the same values.
   */
  function planMigration(localSettings, syncedAlready) {
    if (syncedAlready?.[MIGRATION_FLAG]) {
      return { migrate: false, reason: 'already migrated', writes: {} };
    }
    const { roaming, tooLarge } = partitionSettings(localSettings);
    if (!Object.keys(roaming).length) {
      return { migrate: false, reason: 'nothing to migrate', writes: {}, tooLarge };
    }
    return {
      migrate: true,
      writes: { ...roaming, [MIGRATION_FLAG]: new Date().toISOString() },
      tooLarge
    };
  }


  const api = {
    ROAMING_KEYS, LOCAL_ONLY_KEYS, MIGRATION_FLAG,
    SYNC_ITEM_LIMIT, SYNC_SAFE_ITEM, SYNC_TOTAL_LIMIT,
    fitsInSync, partitionSettings, planMigration
  };

  if (typeof root !== 'undefined') root.SettingsStore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
