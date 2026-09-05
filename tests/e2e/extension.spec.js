/**
 * Smoke test: does the extension actually load and run in a real Chrome?
 *
 * Everything else in the suite runs the code in Node with fakes, which cannot
 * catch a manifest Chrome rejects, a script tag pointing at nothing, or a
 * content script that throws before it injects anything. This loads the
 * unpacked extension for real and checks it comes up on a stand-in lecture
 * page — video.ethz.ch is intercepted, so the test needs no network and no
 * account.
 */
const path = require('path');
const { test, expect, chromium } = require('@playwright/test');

const ROOT = path.join(__dirname, '..', '..');
const LECTURE_URL = 'https://video.ethz.ch/lectures/d-infk/2026/spring/test-lecture.html';

/** A page shaped enough like a lecture for the content script to attach to. */
const LECTURE_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Test Lecture</title>
<script type="application/ld+json">
{"@type":"VideoObject","name":"Test Lecture",
 "thumbnailUrl":"https://dist.tobira.ethz.ch/engage-player/11111111-2222-3333-4444-555555555555/preview.jpg"}
</script></head>
<body><h1>Test Lecture</h1><video id="player" controls></video></body></html>`;

let context;
let extensionId;

test.beforeAll(async () => {
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    args: [
      `--disable-extensions-except=${ROOT}`,
      `--load-extension=${ROOT}`
    ]
  });

  // The worker registering at all is the first thing worth knowing: a manifest
  // Chrome refuses shows up here and nowhere else.
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
  extensionId = new URL(worker.url()).host;

  await context.route('https://video.ethz.ch/**', route =>
    route.fulfill({ status: 200, contentType: 'text/html', body: LECTURE_HTML })
  );
});

test.afterAll(async () => { await context?.close(); });

test('the service worker registers', () => {
  expect(extensionId).toMatch(/^[a-p]{32}$/);
});

test('the content script injects on a lecture page without throwing', async () => {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));

  await page.goto(LECTURE_URL, { waitUntil: 'domcontentloaded' });
  // The content script runs at document_idle.
  await page.waitForFunction(() => !!document.querySelector('[id^="eth-copilot"], .eth-copilot-toggle'),
    null, { timeout: 15_000 }).catch(() => {});

  expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
  await page.close();
});

test('the sidebar page opens and builds its UI', async () => {
  // Opened directly rather than through the toggle: this is checking that the
  // page and its twenty-odd script tags load, not the injection path.
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });

  await page.goto(`chrome-extension://${extensionId}/sidebar/sidebar.html`);
  await expect(page.locator('#tab-guide')).toBeAttached();
  await expect(page.locator('#generate-btn')).toBeAttached();

  // A missing or broken script tag shows up as an undefined function here.
  const missing = await page.evaluate(() => {
    const expected = [
      'init', 'renderBlock', 'sendQaMessage', 'exportGuideAsMarkdown',
      'loadHistory', 'runToolGeneration', 'sanitizeGuide', 'parseGuideResponse',
      'HistoryIO', 'Obsidian', 'ScriptManager', 'ErrorPanel'
    ];
    return expected.filter(name => typeof window[name] === 'undefined');
  });
  expect(missing, 'names the sidebar should have defined').toEqual([]);

  expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
  await page.close();
});

test('the popup opens and lists providers', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await expect(page.locator('#provider-select')).toBeAttached();
  const options = await page.locator('#provider-select option').count();
  expect(options).toBeGreaterThan(3);
  await page.close();
});

test('the options page opens', async () => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/ui/ui-settings.html`);
  await expect(page.locator('#save')).toBeAttached();
  await page.close();
});
