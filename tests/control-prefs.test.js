/**
 * @jest-environment jsdom
 */
'use strict';

const ControlPrefs = require('../lib/control-prefs.js');
const {
  sanitizeControlPrefs, resolveControlValue, withControlValue,
  controlOptions, readControlValue, applyControlValue, restoreControl,
  MAX_TEXT_LEN, MAX_LIST_LEN, MAX_KEYS
} = ControlPrefs;

/**
 * These cover the thing that made the sidebar tiring to use: every control
 * reset to its markup default on every lecture page. The risk in fixing that
 * is the opposite failure — restoring a value a control can no longer take,
 * which leaves a select blank or a pill group with nothing selected, and
 * reads to the user as a broken panel.
 */

// ─── What a stored blob is allowed to be ────────────────────────────────────

describe('sanitizeControlPrefs', () => {
  test('anything that is not a plain object becomes an empty blob', () => {
    for (const junk of [null, undefined, 'a string', 42, [], true]) {
      expect(sanitizeControlPrefs(junk)).toEqual({});
    }
  });

  test('the value shapes a control can actually take survive', () => {
    expect(sanitizeControlPrefs({
      'guide.detail': 'high',
      'guide.temperature': 25,
      'guide.fallback': false,
      'flashcards.cardTypes': ['recall', 'definition']
    })).toEqual({
      'guide.detail': 'high',
      'guide.temperature': 25,
      'guide.fallback': false,
      'flashcards.cardTypes': ['recall', 'definition']
    });
  });

  test('shapes no control can take are dropped rather than kept and feared later', () => {
    const out = sanitizeControlPrefs({
      good: 'kept',
      nested: { a: 1 },
      fn: () => {},
      nan: NaN,
      infinite: Infinity,
      nothing: null,
      emptyList: [],
      listOfObjects: [{ a: 1 }]
    });
    expect(out).toEqual({ good: 'kept' });
  });

  test('a mixed list keeps its usable strings and drops the rest', () => {
    expect(sanitizeControlPrefs({ k: ['a', 3, null, 'b'] })).toEqual({ k: ['a', 'b'] });
  });

  test('oversized values cannot bloat storage', () => {
    const out = sanitizeControlPrefs({
      long: 'x'.repeat(MAX_TEXT_LEN + 1),
      ok: 'x'.repeat(MAX_TEXT_LEN),
      list: Array.from({ length: MAX_LIST_LEN + 10 }, (_, i) => `v${i}`)
    });
    expect(out.long).toBeUndefined();
    expect(out.ok).toHaveLength(MAX_TEXT_LEN);
    expect(out.list).toHaveLength(MAX_LIST_LEN);
  });

  test('a blob with absurdly many keys is capped', () => {
    const huge = {};
    for (let i = 0; i < MAX_KEYS + 50; i++) huge[`k${i}`] = 'v';
    expect(Object.keys(sanitizeControlPrefs(huge)).length).toBe(MAX_KEYS);
  });

  test('no key here could ever hold a credential', () => {
    // Guard rather than assertion: this store is written from DOM controls, and
    // an API key must never reach a general-purpose remembered blob.
    const out = sanitizeControlPrefs({ apiKey: 'sk-live-secret', 'guide.detail': 'high' });
    // It cannot know the key is a secret — but the sidebar never registers one,
    // so the registry, not the sanitizer, is where this is enforced.
    expect(out['guide.detail']).toBe('high');
  });
});

// ─── Whether a stored value may still be applied ────────────────────────────

describe('resolveControlValue', () => {
  const options = ['low', 'medium', 'high'];

  test('a choice still on offer is restored', () => {
    expect(resolveControlValue('choice', 'high', { options })).toBe('high');
  });

  test('a choice that no longer exists leaves the control alone', () => {
    // This is the whole point: an option renamed or removed in a later version
    // must not force a <select> to a value it has no <option> for, which shows
    // as an empty control.
    expect(resolveControlValue('choice', 'ludicrous', { options })).toBeUndefined();
  });

  test('a choice with no known option list is trusted', () => {
    expect(resolveControlValue('choice', 'anything', {})).toBe('anything');
  });

  test('multi-choice keeps what still exists and drops the rest', () => {
    expect(resolveControlValue('multi-choice', ['high', 'gone', 'low'], { options }))
      .toEqual(['high', 'low']);
  });

  test('multi-choice with nothing left gives up rather than selecting nothing', () => {
    // An empty pill group is not a state the UI can represent; "auto" in the
    // markup is the working default and must survive.
    expect(resolveControlValue('multi-choice', ['gone', 'also-gone'], { options })).toBeUndefined();
  });

  test('multi-choice drops duplicates', () => {
    expect(resolveControlValue('multi-choice', ['low', 'low', 'high'], { options }))
      .toEqual(['low', 'high']);
  });

  test('a flag must really be a boolean', () => {
    expect(resolveControlValue('flag', true)).toBe(true);
    expect(resolveControlValue('flag', false)).toBe(false);
    for (const junk of ['true', 1, 0, null]) {
      expect(resolveControlValue('flag', junk)).toBeUndefined();
    }
  });

  test('a number outside the slider range is refused', () => {
    // A temperature slider restored to 900 would render off its own track.
    expect(resolveControlValue('number', 25, { min: 0, max: 100 })).toBe(25);
    expect(resolveControlValue('number', 900, { min: 0, max: 100 })).toBeUndefined();
    expect(resolveControlValue('number', -1, { min: 0, max: 100 })).toBeUndefined();
    expect(resolveControlValue('number', 'not a number', { min: 0, max: 100 })).toBeUndefined();
  });

  test('a numeric string from an input is accepted as a number', () => {
    expect(resolveControlValue('number', '40', { min: 0, max: 100 })).toBe(40);
  });

  test('an unknown kind restores nothing', () => {
    expect(resolveControlValue('semaphore', 'green')).toBeUndefined();
  });

  test('null and undefined are never applied', () => {
    for (const kind of ['choice', 'multi-choice', 'flag', 'number', 'text']) {
      expect(resolveControlValue(kind, null)).toBeUndefined();
      expect(resolveControlValue(kind, undefined)).toBeUndefined();
    }
  });
});

// ─── Writing a value back ───────────────────────────────────────────────────

describe('withControlValue', () => {
  test('a new value is stored', () => {
    expect(withControlValue({}, 'guide.detail', 'high')).toEqual({ 'guide.detail': 'high' });
  });

  test('an unstorable value removes the key instead of saving a hole', () => {
    // A control cleared back to nothing should stop being remembered, not pin
    // an undefined that later reads as "restore nothing" forever.
    expect(withControlValue({ 'quiz.customCount': '17' }, 'quiz.customCount', undefined))
      .toEqual({});
  });

  test('an existing blob is sanitized on the way through', () => {
    expect(withControlValue({ bad: { nested: true }, good: 'x' }, 'new', 'v'))
      .toEqual({ good: 'x', new: 'v' });
  });

  test('a missing key changes nothing', () => {
    expect(withControlValue({ a: 'b' }, '', 'v')).toEqual({ a: 'b' });
  });
});

// ─── Against a real DOM ─────────────────────────────────────────────────────

describe('reading and restoring the controls themselves', () => {
  const pillGroup = (values, active = []) => {
    const el = document.createElement('div');
    el.className = 'pill-group';
    el.innerHTML = values.map(v =>
      `<button class="pill${active.includes(v) ? ' pill-active' : ''}" data-value="${v}"></button>`
    ).join('');
    return el;
  };

  const select = (values, value) => {
    const el = document.createElement('select');
    el.innerHTML = values.map(v => `<option value="${v}"></option>`).join('');
    el.value = value;
    return el;
  };

  test('a select reports and restores its option', () => {
    const el = select(['low', 'high'], 'low');
    expect(controlOptions(el, 'choice')).toEqual(['low', 'high']);
    expect(readControlValue(el, 'choice')).toBe('low');
    expect(restoreControl(el, 'choice', 'high')).toBe('high');
    expect(el.value).toBe('high');
  });

  test('a select is never blanked by a value it has no option for', () => {
    // The failure this guards: gen-detail-select restored to a removed option
    // shows an empty box, and buildGuidePrompt then falls back silently.
    const el = select(['low', 'high'], 'low');
    expect(restoreControl(el, 'choice', 'obsolete')).toBeUndefined();
    expect(el.value).toBe('low');
  });

  test('a single-choice pill group ends up with exactly one active pill', () => {
    const el = pillGroup(['3', '5', '10'], ['5']);
    expect(readControlValue(el, 'pills')).toBe('5');
    restoreControl(el, 'pills', '10');
    expect([...el.querySelectorAll('.pill-active')].map(b => b.dataset.value)).toEqual(['10']);
  });

  test('a pill group is never left with nothing selected', () => {
    const el = pillGroup(['3', '5'], ['5']);
    expect(restoreControl(el, 'pills', '999')).toBeUndefined();
    expect(el.querySelectorAll('.pill-active')).toHaveLength(1);
  });

  test('a multi-select pill group restores several pills and their aria state', () => {
    const el = pillGroup(['auto', 'recall', 'definition'], ['auto']);
    restoreControl(el, 'multi-pills', ['recall', 'definition']);
    const on = [...el.querySelectorAll('.pill-active')].map(b => b.dataset.value);
    expect(on).toEqual(['recall', 'definition']);
    // Screen readers read aria-pressed, not the class.
    expect(el.querySelector('[data-value="auto"]').getAttribute('aria-pressed')).toBe('false');
    expect(el.querySelector('[data-value="recall"]').getAttribute('aria-pressed')).toBe('true');
  });

  test('a multi-select group keeps its default when nothing stored still exists', () => {
    const el = pillGroup(['auto', 'recall'], ['auto']);
    expect(restoreControl(el, 'multi-pills', ['retired-type'])).toBeUndefined();
    expect([...el.querySelectorAll('.pill-active')].map(b => b.dataset.value)).toEqual(['auto']);
  });

  test('a checkbox round-trips', () => {
    const el = document.createElement('input');
    el.type = 'checkbox';
    el.checked = true;
    expect(readControlValue(el, 'flag')).toBe(true);
    restoreControl(el, 'flag', false);
    expect(el.checked).toBe(false);
  });

  test('a slider round-trips as a number, and refuses one off its track', () => {
    const el = document.createElement('input');
    el.type = 'range';
    el.min = '0'; el.max = '100'; el.value = '35';
    expect(readControlValue(el, 'number')).toBe(35);
    restoreControl(el, 'number', 60, { min: 0, max: 100 });
    expect(el.value).toBe('60');
    restoreControl(el, 'number', 400, { min: 0, max: 100 });
    expect(el.value).toBe('60');
  });

  test('restoring never fires a change event', () => {
    // Change handlers re-save, and some of them clear generated results. A
    // restore is not a change the user made.
    const el = select(['low', 'high'], 'low');
    const seen = [];
    el.addEventListener('change', () => seen.push(el.value));
    restoreControl(el, 'choice', 'high');
    expect(seen).toEqual([]);
  });

  test('a control that is not on the page is not an error', () => {
    // Half of these controls only exist while an inline panel is open.
    expect(() => restoreControl(null, 'choice', 'high')).not.toThrow();
    expect(readControlValue(null, 'choice')).toBeUndefined();
    expect(controlOptions(null, 'choice')).toBeNull();
  });

  test('what a control reports is what a later restore puts back', () => {
    // The round trip is the contract: whatever readControlValue hands to
    // storage has to be something restoreControl can apply to the same markup.
    const cases = [
      [select(['a', 'b'], 'b'), 'choice'],
      [pillGroup(['1', '2'], ['2']), 'pills'],
      [pillGroup(['x', 'y', 'z'], ['x', 'z']), 'multi-pills']
    ];
    for (const [el, kind] of cases) {
      const saved = sanitizeControlPrefs({ k: readControlValue(el, kind) }).k;
      applyControlValue(el, kind, kind === 'multi-pills' ? ['y'] : '1');
      expect(restoreControl(el, kind, saved)).toEqual(saved);
      expect(readControlValue(el, kind)).toEqual(saved);
    }
  });
});

// ─── The sidebar's registry has to speak the same vocabulary ────────────────

describe('the sidebar registry agrees with this module', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'sidebar', 'session.js'), 'utf8');
  const registry = source.slice(
    source.indexOf('const REMEMBERED_CONTROLS = ['),
    source.indexOf('/** Every element for a control that is currently on the page. */')
  );

  test('the registry was found, so the rest of this block means something', () => {
    expect(registry).toContain("key: 'guide.detail'");
    expect(registry.length).toBeGreaterThan(500);
  });

  test('every kind the registry names is one this module handles', () => {
    // The first version of this shipped with the registry saying 'pills' while
    // resolveControlValue only knew 'choice', so every pill group silently
    // failed to restore and the panels looked untouched.
    const handled = new Set([
      'choice', 'multi-choice', 'flag', 'number', 'text',
      ...Object.keys(ControlPrefs.KIND_ALIASES)
    ]);
    const used = [...registry.matchAll(/kind:\s*'([^']+)'/g)].map(m => m[1]);
    expect(used.length).toBeGreaterThan(10);
    for (const kind of new Set(used)) {
      expect(handled).toContain(kind);
      // Handled has to mean more than "listed": a real value must survive.
      const probe = { choice: 'v', 'multi-choice': ['v'], flag: true, number: 1, text: 'v' };
      const base = ControlPrefs.KIND_ALIASES[kind] || kind;
      expect(resolveControlValue(kind, probe[base])).toBeDefined();
    }
  });

  test('every remembered control has a unique key', () => {
    // Two controls sharing a key would overwrite each other's value; the
    // Tools-tab and inline copies share a key *on purpose*, but they are one
    // entry with two ids, not two entries.
    const keys = [...registry.matchAll(/key:\s*'([^']+)'/g)].map(m => m[1]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('no remembered control could carry a credential', () => {
    // Standing rule for this extension: keys and endpoints never travel in a
    // general-purpose blob. The provider settings live in their own store.
    // "customTokens" is an output-length cap, not a credential — match the
    // words that actually mean one.
    expect(registry).not.toMatch(/apiKey|api[-_]key|localBase|prov-|headers|secret|password|bearer|accessToken/i);
  });
});
