'use strict';

const {
  DEFAULT_UI_SETTINGS, THEME_KEY_MAP,
  mergeSettings, clamp, deepClone,
  applyColorsToDocument, applySidebarTextSizes
} = require('../lib/ui-settings.js');

/** Just enough document for the two functions that write CSS variables. */
function fakeDoc(theme) {
  const set = {};
  return {
    _set: set,
    documentElement: {
      dataset: theme ? { theme } : {},
      style: { setProperty: (name, value) => { set[name] = value; } }
    }
  };
}

describe('mergeSettings', () => {
  test('nothing saved yet gives the defaults', () => {
    expect(mergeSettings(undefined)).toEqual(DEFAULT_UI_SETTINGS);
    expect(mergeSettings(null)).toEqual(DEFAULT_UI_SETTINGS);
    expect(mergeSettings('not an object')).toEqual(DEFAULT_UI_SETTINGS);
  });

  test('a saved value wins, and everything else keeps its default', () => {
    const merged = mergeSettings({ textSizes: { base: 17 } });
    expect(merged.textSizes.base).toBe(17);
    expect(merged.textSizes.title).toBe(DEFAULT_UI_SETTINGS.textSizes.title);
  });

  test('a new theme added later still gets its defaults', () => {
    // Someone who saved settings before light-white existed must not end up
    // with an empty palette for it.
    const merged = mergeSettings({ colors: { dark: { bg0: '#000' } } });
    expect(merged.colors.dark.bg0).toBe('#000');
    expect(merged.colors.dark.accent).toBe(DEFAULT_UI_SETTINGS.colors.dark.accent);
    expect(merged.colors.lightWhite).toEqual(DEFAULT_UI_SETTINGS.colors.lightWhite);
  });

  test('never hands back the defaults object itself', () => {
    const merged = mergeSettings({});
    merged.textSizes.base = 99;
    expect(DEFAULT_UI_SETTINGS.textSizes.base).not.toBe(99);
  });

  test('all four themes are covered', () => {
    expect(Object.keys(DEFAULT_UI_SETTINGS.colors).sort())
      .toEqual(['dark', 'darkBlue', 'light', 'lightWhite']);
    for (const key of Object.values(THEME_KEY_MAP)) {
      expect(DEFAULT_UI_SETTINGS.colors[key]).toBeDefined();
    }
  });
});

describe('clamp', () => {
  test('keeps a size inside its range', () => {
    expect(clamp(15, 11, 18, 13)).toBe(15);
    expect(clamp(99, 11, 18, 13)).toBe(18);
    expect(clamp(1, 11, 18, 13)).toBe(11);
  });

  test('falls back rather than writing NaN into a stylesheet', () => {
    expect(clamp('abc', 11, 18, 13)).toBe(13);
    expect(clamp(undefined, 11, 18, 13)).toBe(13);
    expect(clamp(Infinity, 11, 18, 13)).toBe(13);
  });
});

describe('applySidebarTextSizes', () => {
  test('writes every size as a pixel value', () => {
    const doc = fakeDoc('dark');
    applySidebarTextSizes(doc, DEFAULT_UI_SETTINGS);
    expect(doc._set['--ui-font-base-size']).toBe('13px');
    expect(doc._set['--ui-font-title-size']).toBe('16px');
    expect(doc._set['--ui-font-meta-size']).toBe('11px');
  });

  test('an absurd saved size is clamped, not written through', () => {
    const doc = fakeDoc('dark');
    applySidebarTextSizes(doc, { textSizes: { base: 900 } });
    expect(doc._set['--ui-font-base-size']).toBe('18px');
  });

  test('missing sizes fall back instead of producing NaNpx', () => {
    const doc = fakeDoc('dark');
    applySidebarTextSizes(doc, {});
    expect(Object.values(doc._set).every(v => /^[\d.]+px$/.test(v))).toBe(true);
  });
});

describe('applyColorsToDocument', () => {
  test('uses the palette for the theme the page is showing', () => {
    const doc = fakeDoc('dark-blue');
    applyColorsToDocument(doc, DEFAULT_UI_SETTINGS);
    expect(doc._set['--bg-0']).toBe(DEFAULT_UI_SETTINGS.colors.darkBlue.bg0);
    expect(doc._set['--accent']).toBe(DEFAULT_UI_SETTINGS.colors.darkBlue.accent);
  });

  test('each theme gets its own colours', () => {
    const seen = new Set();
    for (const theme of Object.keys(THEME_KEY_MAP)) {
      const doc = fakeDoc(theme);
      applyColorsToDocument(doc, DEFAULT_UI_SETTINGS);
      seen.add(doc._set['--bg-0']);
    }
    expect(seen.size).toBe(Object.keys(THEME_KEY_MAP).length);
  });

  test('an unknown theme falls back rather than writing undefined', () => {
    const doc = fakeDoc('theme-from-the-future');
    applyColorsToDocument(doc, DEFAULT_UI_SETTINGS);
    expect(doc._set['--bg-0']).toBe(DEFAULT_UI_SETTINGS.colors.dark.bg0);
  });

  test('a settings object with no palette writes nothing at all', () => {
    const doc = fakeDoc('dark');
    applyColorsToDocument(doc, { colors: {} });
    expect(Object.keys(doc._set)).toHaveLength(0);
  });
});

describe('deepClone', () => {
  test('changes to the copy do not reach the original', () => {
    const original = { a: { b: 1 } };
    const copy = deepClone(original);
    copy.a.b = 2;
    expect(original.a.b).toBe(1);
  });
});
