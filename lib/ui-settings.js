/**
 * Shared UI settings for popup/sidebar/options page.
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'uiSettings';

  const DEFAULT_UI_SETTINGS = {
    textSizes: {
      base: 13,
      title: 16,
      sectionLabel: 11,
      content: 13.5,
      meta: 11
    },
    colors: {
      dark: {
        bg0: '#1c1a14',
        bg1: '#242019',
        bg2: '#2c281e',
        bg3: '#352f24',
        border: 'rgba(255, 232, 195, 0.09)',
        textPrimary: '#f0e6d3',
        textSecondary: '#b5a188',
        textMuted: '#7e6e5a',
        accent: '#c89060',
        accentDim: 'rgba(200, 144, 96, 0.14)',
        accentHover: '#d8a474'
      },
      light: {
        bg0: '#f5f0e8',
        bg1: '#ede5d4',
        bg2: '#e2d9c6',
        bg3: '#d5ccb6',
        border: 'rgba(100, 65, 20, 0.12)',
        textPrimary: '#2a1e0e',
        textSecondary: '#6b5030',
        textMuted: '#9a8060',
        accent: '#a06030',
        accentDim: 'rgba(160, 96, 48, 0.1)',
        accentHover: '#7e4a1e'
      },
      darkBlue: {
        bg0: '#0d1422',
        bg1: '#131c32',
        bg2: '#1b2844',
        bg3: '#233258',
        border: 'rgba(100, 160, 255, 0.09)',
        textPrimary: '#dce8f8',
        textSecondary: '#7ea8d8',
        textMuted: '#4a6898',
        accent: '#5b9cf6',
        accentDim: 'rgba(91, 156, 246, 0.12)',
        accentHover: '#80b4ff'
      },
      lightWhite: {
        bg0: '#ffffff',
        bg1: '#f5f6fa',
        bg2: '#eceef5',
        bg3: '#e0e3ee',
        border: 'rgba(40, 50, 100, 0.08)',
        textPrimary: '#141828',
        textSecondary: '#424876',
        textMuted: '#8890b4',
        accent: '#3b66f5',
        accentDim: 'rgba(59, 102, 245, 0.08)',
        accentHover: '#2450d8'
      }
    }
  };

  // Maps data-theme attribute values to the colors key in settings
  const THEME_KEY_MAP = {
    'dark':        'dark',
    'light':       'light',
    'dark-blue':   'darkBlue',
    'light-white': 'lightWhite'
  };

  function deepClone(v) {
    return JSON.parse(JSON.stringify(v));
  }

  function mergeSettings(saved) {
    const merged = deepClone(DEFAULT_UI_SETTINGS);
    if (!saved || typeof saved !== 'object') return merged;
    if (saved.textSizes && typeof saved.textSizes === 'object') {
      Object.assign(merged.textSizes, saved.textSizes);
    }
    if (saved.colors?.dark)       Object.assign(merged.colors.dark,       saved.colors.dark);
    if (saved.colors?.light)      Object.assign(merged.colors.light,      saved.colors.light);
    if (saved.colors?.darkBlue)   Object.assign(merged.colors.darkBlue,   saved.colors.darkBlue);
    if (saved.colors?.lightWhite) Object.assign(merged.colors.lightWhite, saved.colors.lightWhite);
    return merged;
  }

  function load() {
    return new Promise((resolve) => {
      chrome.storage.local.get([STORAGE_KEY], (saved) => {
        resolve(mergeSettings(saved[STORAGE_KEY]));
      });
    });
  }

  function save(settings) {
    return new Promise((resolve) => {
      const merged = mergeSettings(settings);
      chrome.storage.local.set({ [STORAGE_KEY]: merged }, () => resolve(merged));
    });
  }

  function restoreAllDefaults() {
    return save(deepClone(DEFAULT_UI_SETTINGS));
  }

  function applyColorsToDocument(doc, settings) {
    const html = doc.documentElement;
    const themeAttr = html.dataset.theme || 'dark';
    const settingsKey = THEME_KEY_MAP[themeAttr] || 'dark';
    const c = settings.colors[settingsKey];
    if (!c) return;
    const style = html.style;
    style.setProperty('--bg-0', c.bg0);
    style.setProperty('--bg-1', c.bg1);
    style.setProperty('--bg-2', c.bg2);
    style.setProperty('--bg-3', c.bg3);
    style.setProperty('--border', c.border);
    style.setProperty('--text-primary', c.textPrimary);
    style.setProperty('--text-secondary', c.textSecondary);
    style.setProperty('--text-muted', c.textMuted);
    style.setProperty('--accent', c.accent);
    style.setProperty('--accent-dim', c.accentDim);
    style.setProperty('--accent-hover', c.accentHover);
  }

  function clamp(v, min, max, fallback) {
    const n = Number(v);
    if (!isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  function applySidebarTextSizes(doc, settings) {
    const html = doc.documentElement;
    const s = settings.textSizes || {};
    html.style.setProperty('--ui-font-base-size', `${clamp(s.base, 11, 18, 13)}px`);
    html.style.setProperty('--ui-font-title-size', `${clamp(s.title, 13, 24, 16)}px`);
    html.style.setProperty('--ui-font-section-size', `${clamp(s.sectionLabel, 9, 16, 11)}px`);
    html.style.setProperty('--ui-font-content-size', `${clamp(s.content, 11, 20, 13.5)}px`);
    html.style.setProperty('--ui-font-meta-size', `${clamp(s.meta, 9, 16, 11)}px`);
  }

  const api = {
    STORAGE_KEY,
    DEFAULT_UI_SETTINGS,
    THEME_KEY_MAP,
    deepClone,
    mergeSettings,
    clamp,
    load,
    save,
    restoreAllDefaults,
    applyColorsToDocument,
    applySidebarTextSizes
  };

  // Same dual export as the other lib files, so the merging and clamping can
  // be tested in Node rather than only in a browser.
  if (typeof window !== 'undefined') window.UISettings = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
