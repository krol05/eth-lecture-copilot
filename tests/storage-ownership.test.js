'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/**
 * The extension keeps state in four places, and which one a value belongs in
 * is a rule, not a preference — it is written down in the header of
 * lib/settings-store.js.
 *
 * The rule exists because it was broken: the Q&A thinking, response-length and
 * response-style selects ended up saved to localStorage *and* to
 * chrome.storage.local through the remembered-controls registry, so one value
 * had two owners. Anything that happens to be async-safe drifts into
 * localStorage simply because localStorage is easy to reach.
 *
 * So localStorage gets an allowlist. Adding a key here is allowed — but it
 * should be a deliberate act with a reason next to it, not a default.
 */

/** Every file that could touch the browser. */
function sourceFiles() {
  const dirs = ['sidebar', 'popup', 'ui', 'content', 'background', 'lib'];
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'katex') walk(p);
      } else if (p.endsWith('.js')) {
        out.push(p);
      }
    }
  };
  for (const d of dirs) walk(path.join(ROOT, d));
  return out;
}

/**
 * localStorage keys, resolved through the one level of indirection the code
 * actually uses: a module-level `const NAME = 'literal'` passed to
 * getItem/setItem/removeItem.
 */
function localStorageKeys() {
  const found = new Set();
  const unresolved = [];
  for (const file of sourceFiles()) {
    const src = fs.readFileSync(file, 'utf8');
    const consts = Object.fromEntries(
      [...src.matchAll(/const\s+([A-Z_][A-Z0-9_]*)\s*=\s*'([^']+)'/g)].map(m => [m[1], m[2]])
    );
    // sidebar/print-common.js is shared by the two print pages, each of which
    // passes its own key into runPrintPage. Count those literals where they
    // are written, not every `key:` property in the tree.
    for (const m of src.matchAll(/runPrintPage\(\{[^}]*?\bkey:\s*'([^']+)'/gs)) found.add(m[1]);
    for (const m of src.matchAll(/localStorage\.(?:get|set|remove)Item\(\s*([^,)]+)/g)) {
      const arg = m[1].trim();
      const literal = arg.match(/^'([^']+)'$/);
      if (literal) { found.add(literal[1]); continue; }
      if (consts[arg]) { found.add(consts[arg]); continue; }
      // A bare `key` is print-common.js's parameter; its literals are picked
      // up above from the pages that call it.
      if (arg === 'key') continue;
      unresolved.push(`${path.relative(ROOT, file)}: ${arg}`);
    }
  }
  return { found, unresolved };
}

/**
 * The allowlist. Each entry needs a reason that is about *timing or reach*,
 * not convenience — that is the whole test.
 */
const ALLOWED = {
  'eth-copilot-theme':
    'set on <html> before first paint; async storage would flash the wrong theme',
  'eth-copilot-auto-time-follow':
    'read into a module variable at load in sidebar/state.js and used by logic immediately',
  'eth-copilot-genbar-collapsed':
    'sidebar/generation-bar.js is a self-contained module with no chrome access',
  'eth-copilot-qa-customization-open':
    'disclosure state of a <details>, read before it first paints — not a preference',
  'eth-copilot-script-search-method':
    'restored during init alongside side effects the registry does not run',
  'eth-copilot-tool-outputs':
    'synchronous fallback that works before currentLectureUrl has propagated',
  'eth-copilot-print-summary':
    'hand-off to the print window, which is a separate page',
  'eth-copilot-print-guide':
    'hand-off to the print window, which is a separate page'
};

describe('localStorage stays on its allowlist', () => {
  const { found, unresolved } = localStorageKeys();

  test('every key reached is one this test can see', () => {
    // A key built at runtime would slip past the allowlist silently.
    expect(unresolved).toEqual([]);
  });

  test('no key is used that the rule has not accounted for', () => {
    // If this goes red: read the store-ownership rule at the top of
    // lib/settings-store.js. Most preferences belong in chrome.storage.local
    // through REMEMBERED_CONTROLS in sidebar/session.js. If the new key really
    // does need a synchronous read, add it to ALLOWED with the reason why.
    const extra = [...found].filter(k => !(k in ALLOWED)).sort();
    expect(extra).toEqual([]);
  });

  test('the allowlist has no entries that nothing uses any more', () => {
    const stale = Object.keys(ALLOWED).filter(k => !found.has(k)).sort();
    expect(stale).toEqual([]);
  });

  test.each(Object.keys(ALLOWED))('%s says why it needs a synchronous read', (key) => {
    expect(typeof ALLOWED[key]).toBe('string');
    expect(ALLOWED[key].length).toBeGreaterThan(20);
  });
});

describe('the remembered-control registry does not share a value with localStorage', () => {
  const session = fs.readFileSync(path.join(ROOT, 'sidebar', 'session.js'), 'utf8');
  const registry = session.slice(
    session.indexOf('const REMEMBERED_CONTROLS = ['),
    session.indexOf('/** Every element for a control that is currently on the page. */')
  );

  test('no control in the registry is also saved to localStorage', () => {
    // The exact mistake this guards: qa-thinking, qa-response-length and
    // qa-response-style were added to the registry while main.js kept saving
    // them to localStorage, so the same value had two owners and which one
    // won came down to callback ordering.
    const ids = [...registry.matchAll(/'([a-z0-9-]+)'/g)].map(m => m[1])
      .filter(v => v.includes('-'));
    expect(ids.length).toBeGreaterThan(20);

    const { found } = localStorageKeys();
    const clash = [];
    for (const id of new Set(ids)) {
      for (const key of found) {
        // "qa-thinking-select" vs "eth-copilot-qa-thinking"
        const stem = id.replace(/-(select|pills|cb|input|slider)$/, '');
        if (key === `eth-copilot-${stem}`) clash.push(`${id} <-> ${key}`);
      }
    }
    expect(clash).toEqual([]);
  });
});
