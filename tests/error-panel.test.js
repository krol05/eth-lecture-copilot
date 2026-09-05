/**
 * @jest-environment jsdom
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/**
 * Load error-panel.js into this jsdom document with a fake chrome.storage.
 * The panel is the last thing standing between a failed request and the user
 * seeing nothing, so it is worth exercising against a real DOM.
 */
function loadPanel({ history = [] } = {}) {
  document.body.innerHTML = '<div class="sidebar-header">header</div>';
  const store = { errorHistory: [...history] };

  global.chrome = {
    storage: {
      local: {
        get: (keys, cb) => {
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of list) if (k in store) out[k] = store[k];
          cb(out);
        },
        set: (obj, cb) => { Object.assign(store, obj); if (cb) cb(); }
      }
    }
  };

  // Both files publish themselves onto `self`. Running them through a function
  // with `self` bound to this jsdom window is what puts them somewhere the
  // test can see — vm.runInThisContext lands in Node's context instead.
  for (const file of ['lib/error-format.js', 'sidebar/error-panel.js']) {
    const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
    new Function('self', 'window', 'chrome', 'module', 'require', code)
      .call(window, window, window, global.chrome, undefined, undefined);
  }
  return { store, ErrorPanel: window.ErrorPanel };
}

const providerError = (over = {}) => ({
  status: 401,
  provider: 'openai',
  model: 'gpt-5.5',
  code: 'invalid_api_key',
  message: 'Incorrect API key provided',
  raw: { error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } },
  timestamp: Date.now(),
  ...over
});

/** Storage callbacks are synchronous here, but report() awaits a promise. */
const settle = () => new Promise(r => setTimeout(r, 0));

describe('the error panel', () => {
  afterEach(() => { delete global.chrome; document.body.innerHTML = ''; });

  test('appears when something fails, and says what', async () => {
    const { ErrorPanel } = loadPanel();
    ErrorPanel.report(providerError());
    await settle();

    const panel = document.querySelector('.cop-err-panel');
    expect(panel).not.toBeNull();
    expect(panel.classList.contains('cop-err-hidden')).toBe(false);
    // The whole point of the panel: the real provider message, not "an error".
    expect(panel.textContent).toContain('Incorrect API key provided');
    expect(panel.textContent).toMatch(/401/);
  });

  test('shows the raw provider body, so nothing is hidden', async () => {
    const { ErrorPanel } = loadPanel();
    ErrorPanel.report(providerError());
    await settle();
    expect(document.querySelector('.cop-err-details').textContent)
      .toContain('invalid_request_error');
  });

  test('minimizes to a badge and comes back', async () => {
    const { ErrorPanel } = loadPanel();
    ErrorPanel.report(providerError());
    await settle();

    const panel = document.querySelector('.cop-err-panel');
    const badge = document.querySelector('.cop-err-badge');

    document.querySelectorAll('.cop-err-btn')[0].click();   // minimize
    expect(panel.classList.contains('cop-err-hidden')).toBe(true);
    expect(badge.classList.contains('cop-err-hidden')).toBe(false);

    badge.click();
    expect(panel.classList.contains('cop-err-hidden')).toBe(false);
    expect(badge.classList.contains('cop-err-hidden')).toBe(true);
  });

  test('dismissing hides both the panel and the badge', async () => {
    const { ErrorPanel } = loadPanel();
    ErrorPanel.report(providerError());
    await settle();

    document.querySelectorAll('.cop-err-btn')[1].click();   // dismiss
    expect(document.querySelector('.cop-err-panel').classList.contains('cop-err-hidden')).toBe(true);
    expect(document.querySelector('.cop-err-badge').classList.contains('cop-err-hidden')).toBe(true);
  });

  test('sits under the header rather than covering it', async () => {
    const { ErrorPanel } = loadPanel();
    ErrorPanel.report(providerError());
    await settle();
    // It used to float over the toolbar, which put it on top of a button.
    expect(document.querySelector('.sidebar-header').nextElementSibling.className)
      .toContain('cop-err-badge');
  });

  test('keeps errors in storage so they survive a reload', async () => {
    const { ErrorPanel, store } = loadPanel();
    ErrorPanel.report(providerError({ message: 'first' }));
    await settle();
    ErrorPanel.report(providerError({ message: 'second' }));
    await settle();

    expect(store.errorHistory).toHaveLength(2);
    expect(store.errorHistory[0].message).toBe('second');   // newest first
  });

  test('the history drawer opens, lists what happened, and closes again', async () => {
    const { ErrorPanel } = loadPanel();
    ErrorPanel.report(providerError({ message: 'the failure' }));
    await settle();

    const drawer = document.querySelector('.cop-err-history');
    const historyBtn = [...document.querySelectorAll('.cop-err-link')]
      .find(b => b.textContent.startsWith('History'));

    expect(drawer.classList.contains('cop-err-hidden')).toBe(true);
    historyBtn.click();
    await settle();
    expect(drawer.classList.contains('cop-err-hidden')).toBe(false);
    expect(drawer.textContent).toContain('the failure');

    historyBtn.click();
    expect(drawer.classList.contains('cop-err-hidden')).toBe(true);
  });

  test('clearing empties the stored history, not just the view', async () => {
    const { ErrorPanel, store } = loadPanel();
    ErrorPanel.report(providerError());
    await settle();

    [...document.querySelectorAll('.cop-err-link')]
      .find(b => b.textContent === 'Clear all').click();
    await settle();

    expect(store.errorHistory).toEqual([]);
    expect(document.querySelector('.cop-err-history').textContent).toContain('cleared');
  });

  test('offers a fix button only when the failure has one', async () => {
    const { ErrorPanel } = loadPanel();

    ErrorPanel.report(providerError());
    await settle();
    expect(document.querySelector('.cop-err-fix').classList.contains('cop-err-hidden')).toBe(true);

    ErrorPanel.report(providerError({
      code: 'permission_missing',
      raw: { origin: 'https://api.groq.com/*', host: 'api.groq.com' }
    }));
    await settle();
    const fix = document.querySelector('.cop-err-fix');
    expect(fix.classList.contains('cop-err-hidden')).toBe(false);
    expect(fix.textContent).toContain('api.groq.com');
  });

  test('never shows a raw match pattern to the reader', async () => {
    const { ErrorPanel } = loadPanel();
    ErrorPanel.report(providerError({
      code: 'permission_missing',
      raw: { origin: '<all_urls>', host: '<all_urls>' }
    }));
    await settle();
    expect(document.querySelector('.cop-err-fix').textContent).not.toContain('<all_urls>');
  });

  test('an error with almost nothing in it still renders', async () => {
    const { ErrorPanel } = loadPanel();
    expect(() => ErrorPanel.report({ message: 'something went wrong' })).not.toThrow();
    await settle();
    expect(document.querySelector('.cop-err-panel').textContent).toContain('something went wrong');
  });
});
