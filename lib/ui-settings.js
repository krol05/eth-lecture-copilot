/**
 * Shared UI settings for popup/sidebar/options page.
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'uiSettings';

  const DEFAULT_UI_SETTINGS = {
    sidebarScale: 100,
    colors: {
      dark: {
        bg0: '#0f1117',
        bg1: '#161b22',
        bg2: '#1e2430',
        bg3: '#252d3a',
        border: 'rgba(255, 255, 255, 0.08)',
        textPrimary: '#e6edf3',
        textSecondary: '#9da7b3',
        textMuted: '#7a8494',
        accent: '#8fb0ff',
        accentDim: 'rgba(143, 176, 255, 0.14)',
        accentHover: '#afc6ff'
      },
      light: {
        bg0: '#ffffff',
        bg1: '#f6f8fa',
        bg2: '#eaeef2',
        bg3: '#d0d7de',
        border: 'rgba(0, 0, 0, 0.08)',
        textPrimary: '#1f2328',
        textSecondary: '#57606a',
        textMuted: '#8c959f',
        accent: '#215caf',
        accentDim: 'rgba(33, 92, 175, 0.1)',
        accentHover: '#014083'
      }
    }
  };

  function deepClone(v) {
    return JSON.parse(JSON.stringify(v));
  }

  function mergeSettings(saved) {
    const merged = deepClone(DEFAULT_UI_SETTINGS);
    if (!saved || typeof saved !== 'object') return merged;
    if (typeof saved.sidebarScale === 'number') merged.sidebarScale = saved.sidebarScale;
    if (saved.colors?.dark) Object.assign(merged.colors.dark, saved.colors.dark);
    if (saved.colors?.light) Object.assign(merged.colors.light, saved.colors.light);
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
    const theme = html.dataset.theme === 'light' ? 'light' : 'dark';
    const c = settings.colors[theme];
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

  function applySidebarScale(doc, settings) {
    const body = doc.body;
    if (!body) return;
    const scale = Math.max(80, Math.min(130, settings.sidebarScale || 100));
    body.style.zoom = String(scale / 100);
  }

  window.UISettings = {
    STORAGE_KEY,
    DEFAULT_UI_SETTINGS,
    deepClone,
    mergeSettings,
    load,
    save,
    restoreAllDefaults,
    applyColorsToDocument,
    applySidebarScale
  };
})();

