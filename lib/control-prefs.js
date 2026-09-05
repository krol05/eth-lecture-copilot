/**
 * control-prefs.js — deciding what a remembered sidebar control is worth.
 *
 * The sidebar is an iframe injected per lecture page, so it is built from
 * scratch every time a lecture is opened. Everything the user picked — guide
 * language, block detail, card types, exam difficulty — came only from the
 * HTML defaults, and was picked again on the next lecture, forever. A handful
 * of controls had grown their own one-off persistence (the per-tool thinking
 * level in chrome.storage.local, the script search method in localStorage);
 * the rest had none, so two controls in the same panel behaved differently.
 *
 * This file holds the part that has to be right: deciding whether a value
 * saved earlier may still be applied to a control now. The sidebar owns the
 * DOM; this owns the judgement.
 *
 * Values are keyed by element id, so the option lists live in the HTML alone
 * and are never duplicated here. That means a renamed or removed option needs
 * no migration: the stored value simply stops being restorable, and the
 * control keeps its HTML default.
 */
(function (root) {
  'use strict';

  /** Cheap ceilings. These are convenience values, not documents. */
  const MAX_KEYS = 120;
  const MAX_TEXT_LEN = 200;
  const MAX_LIST_LEN = 40;

  /**
   * A stored blob is whatever was in storage last — possibly written by an
   * older version, possibly corrupted, possibly not an object at all. Reduce
   * it to plain values of the shapes a control can actually take.
   */
  function sanitizeControlPrefs(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out = {};
    let kept = 0;
    for (const [key, value] of Object.entries(raw)) {
      if (kept >= MAX_KEYS) break;
      if (typeof key !== 'string' || !key || key.length > MAX_TEXT_LEN) continue;
      const clean = sanitizeValue(value);
      if (clean === undefined) continue;
      out[key] = clean;
      kept++;
    }
    return out;
  }

  function sanitizeValue(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (typeof value === 'string') return value.length <= MAX_TEXT_LEN ? value : undefined;
    if (Array.isArray(value)) {
      const list = value
        .filter(v => typeof v === 'string' && v.length <= MAX_TEXT_LEN)
        .slice(0, MAX_LIST_LEN);
      return list.length ? list : undefined;
    }
    return undefined;
  }

  /**
   * Can `stored` be applied to a control of this kind right now?
   *
   * Returns the value to apply, or undefined to mean "leave the control
   * alone". Undefined is the safe answer for anything unrecognised: the HTML
   * default is always a working state, and a select forced to a value it has
   * no option for goes blank, which reads as a broken panel.
   *
   * @param {string} kind     choice | multi-choice | flag | number | text,
   *                          or one of the UI-facing aliases in KIND_ALIASES
   * @param {any} stored      the value read back from storage
   * @param {object} [opts]
   * @param {string[]} [opts.options]  values the control currently offers
   * @param {number} [opts.min]
   * @param {number} [opts.max]
   */
  /**
   * The sidebar names controls by what they look like ('pills'), while the
   * rules below care only about what a value is ('choice'). Keeping one
   * vocabulary here means a spec cannot silently name a kind nothing handles.
   */
  const KIND_ALIASES = {
    pills: 'choice',
    'multi-pills': 'multi-choice',
    select: 'choice',
    checkbox: 'flag',
    range: 'number'
  };

  function resolveControlValue(kind, stored, opts = {}) {
    if (stored === undefined || stored === null) return undefined;
    const options = Array.isArray(opts.options) ? opts.options : null;

    switch (KIND_ALIASES[kind] || kind) {
      case 'choice': {
        if (typeof stored !== 'string') return undefined;
        if (options && !options.includes(stored)) return undefined;
        return stored;
      }
      case 'multi-choice': {
        if (!Array.isArray(stored)) return undefined;
        const seen = new Set();
        const kept = [];
        for (const v of stored) {
          if (typeof v !== 'string' || seen.has(v)) continue;
          if (options && !options.includes(v)) continue;
          seen.add(v);
          kept.push(v);
        }
        // An empty selection is not a state the pill groups can represent, so
        // it means "nothing usable survived" rather than "select nothing".
        return kept.length ? kept : undefined;
      }
      case 'flag':
        return typeof stored === 'boolean' ? stored : undefined;
      case 'number': {
        const n = typeof stored === 'number' ? stored : Number(stored);
        if (!Number.isFinite(n)) return undefined;
        if (Number.isFinite(opts.min) && n < opts.min) return undefined;
        if (Number.isFinite(opts.max) && n > opts.max) return undefined;
        return n;
      }
      case 'text':
        return typeof stored === 'string' && stored.length <= MAX_TEXT_LEN ? stored : undefined;
      default:
        return undefined;
    }
  }

  /**
   * Merge one control's new value into the saved blob.
   *
   * Storing `undefined` removes the key rather than saving a hole, so a
   * control returned to its default stops being remembered instead of
   * pinning the default in place forever.
   */
  function withControlValue(prefs, key, value) {
    const base = sanitizeControlPrefs(prefs);
    if (typeof key !== 'string' || !key) return base;
    const clean = sanitizeValue(value);
    if (clean === undefined) {
      delete base[key];
      return base;
    }
    base[key] = clean;
    return base;
  }


  // ─── Reading and writing the controls themselves ────────────────────────
  //
  // These take elements rather than ids so they can be exercised against a
  // real DOM in tests. The sidebar supplies the elements; the rules for what
  // a control's value looks like live here with the rules for trusting it.

  /** The values a control offers right now, or null when it is not a choice. */
  function controlOptions(el, kind) {
    if (!el) return null;
    if (kind === 'choice') return [...el.options].map(o => o.value);
    if (kind === 'pills' || kind === 'multi-pills') {
      return [...el.querySelectorAll('.pill')].map(b => b.dataset.value).filter(Boolean);
    }
    return null;
  }

  /** What the user has this control set to, in a shape worth storing. */
  function readControlValue(el, kind) {
    if (!el) return undefined;
    switch (kind) {
      case 'choice':
      case 'text':
        return el.value;
      case 'flag':
        return !!el.checked;
      case 'number':
        return Number(el.value);
      case 'pills':
        return el.querySelector('.pill.pill-active')?.dataset.value;
      case 'multi-pills':
        return [...el.querySelectorAll('.pill.pill-active')].map(b => b.dataset.value).filter(Boolean);
      default:
        return undefined;
    }
  }

  /**
   * Put a remembered value back on a control.
   *
   * Assigning directly rather than dispatching an event: restoring what the
   * user already chose is not a change, and firing change handlers here would
   * re-save the value and, worse, re-run side effects like clearing results.
   */
  function applyControlValue(el, kind, value) {
    if (!el) return;
    switch (kind) {
      case 'choice':
      case 'text':
      case 'number':
        el.value = String(value);
        break;
      case 'flag':
        el.checked = !!value;
        break;
      case 'pills':
        el.querySelectorAll('.pill').forEach(b =>
          b.classList.toggle('pill-active', b.dataset.value === value));
        break;
      case 'multi-pills': {
        const wanted = new Set(value);
        el.querySelectorAll('.pill').forEach(b => {
          const on = wanted.has(b.dataset.value);
          b.classList.toggle('pill-active', on);
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        break;
      }
    }
  }

  /**
   * Restore one control from storage, if the stored value still means
   * something. Returns the value applied, or undefined when the control was
   * deliberately left at its markup default.
   */
  function restoreControl(el, kind, stored, opts = {}) {
    const value = resolveControlValue(kind, stored, {
      options: controlOptions(el, kind),
      min: opts.min,
      max: opts.max
    });
    if (value === undefined) return undefined;
    applyControlValue(el, kind, value);
    return value;
  }

  const api = {
    sanitizeControlPrefs,
    resolveControlValue,
    withControlValue,
    KIND_ALIASES,
    controlOptions,
    readControlValue,
    applyControlValue,
    restoreControl,
    MAX_KEYS,
    MAX_TEXT_LEN,
    MAX_LIST_LEN
  };

  if (typeof root !== 'undefined') root.ControlPrefs = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
