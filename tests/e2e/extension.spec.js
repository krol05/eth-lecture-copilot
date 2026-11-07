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
  // Exam depth was written into the prompt long before it had a control.
  await expect(page.locator('#exam-depth-pills .pill')).toHaveCount(3);

  // A missing or broken script tag shows up as an undefined function here.
  const missing = await page.evaluate(() => {
    const expected = [
      'init', 'renderBlock', 'sendQaMessage', 'exportGuideAsMarkdown',
      'loadHistory', 'runToolGeneration', 'sanitizeGuide', 'parseGuideResponse',
      'HistoryIO', 'Obsidian', 'ScriptManager', 'ErrorPanel',
      'ControlPrefs', 'createJsonArrayScanner', 'appendPromptExtras',
      'buildGuidePrompt', 'setUpRememberedControls'
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

test('the sidebar remembers the controls you set, across a reload', async () => {
  // The reason this feature exists: the sidebar is rebuilt on every lecture
  // page, so until now every control came back at its markup default and you
  // re-picked language, detail, card types and difficulty on each lecture.
  // Only a real browser exercises the whole path — chrome.storage, the
  // registry, and the DOM the values are read from and put back on.
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidebar/sidebar.html`);
  await expect(page.locator('#gen-detail-select')).toBeAttached();

  // Defaults first, so the assertions below cannot pass by accident.
  await expect(page.locator('#gen-detail-select')).toHaveValue('very_high');
  await expect(page.locator('#exam-depth-pills .pill.pill-active')).toHaveAttribute('data-value', 'deep');

  await page.selectOption('#gen-detail-select', 'medium');

  // The tool controls live behind the Tools tab and a collapsed section, so
  // drive them the way a user does rather than clicking through the DOM.
  await page.click('.tab-btn[data-tab="tools"]');
  await page.click('#tool-exam > summary');
  await page.click('#exam-depth-pills .pill[data-value="research"]');
  await page.click('#exam-difficulty-pills .pill[data-value="hard"]');
  await page.click('#tool-flashcards > summary');
  await page.click('#flashcards-count-pills .pill[data-value="20"]');
  // A typed value has to survive too — these save on input, not on blur.
  await page.click('#tool-quiz > summary');
  await page.fill('#quiz-custom-count', '17');

  // chrome.storage.local writes are async; wait for the value to land.
  await page.waitForFunction(async () => {
    const r = await chrome.storage.local.get('sidebarControlPrefs');
    return r.sidebarControlPrefs?.['exam.depth'] === 'research';
  }, null, { timeout: 5000 });

  await page.reload();
  await expect(page.locator('#gen-detail-select')).toHaveValue('medium');
  await expect(page.locator('#exam-depth-pills .pill.pill-active')).toHaveAttribute('data-value', 'research');
  await expect(page.locator('#exam-difficulty-pills .pill.pill-active')).toHaveAttribute('data-value', 'hard');
  await expect(page.locator('#flashcards-count-pills .pill.pill-active')).toHaveAttribute('data-value', '20');
  await expect(page.locator('#quiz-custom-count')).toHaveValue('17');

  await page.close();
});

test('a remembered value the control no longer offers is ignored, not applied', async () => {
  // The opposite failure: a stored value from an older build must never force
  // a select to an option it does not have, which renders as an empty box.
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidebar/sidebar.html`);
  await expect(page.locator('#gen-detail-select')).toBeAttached();

  await page.evaluate(async () => {
    await chrome.storage.local.set({
      sidebarControlPrefs: { 'guide.detail': 'an-option-that-was-removed' }
    });
  });
  await page.reload();
  await expect(page.locator('#gen-detail-select')).toHaveValue('very_high');

  await page.evaluate(async () => { await chrome.storage.local.remove('sidebarControlPrefs'); });
  await page.close();
});

test('History opens on the course you are watching', async () => {
  // Every level of the History tree already worked out whether it held the
  // active lecture — buildYearGroup got activeYS, buildSeasonGroup got
  // isActiveSeason, buildCourseGroup computed hasActive — and none of them
  // acted on it, so History always opened fully collapsed. This drives the
  // real render path rather than asserting on source.
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidebar/sidebar.html`);
  await expect(page.locator('#history-list')).toBeAttached();

  const ACTIVE = 'https://video.ethz.ch/lectures/d-infk/2026/spring/401-0663-00L/aaa.html';
  const OTHER = 'https://video.ethz.ch/lectures/d-infk/2025/fall/252-0061-00L/bbb.html';

  await page.evaluate(async ([activeUrl, otherUrl]) => {
    const entry = (url, title, date) => ({
      lectureUrl: url, courseName: title, courseKey: url.split('/')[6],
      date, guideDate: date, guideTitle: title,
      guide: { guide_title: title, guide: [{ title: 'Block', start_time: 0, end_time: 60 }] }
    });
    await chrome.storage.local.set({
      guideHistory: [
        entry(activeUrl, 'Numerical Methods', '2026-03-01'),
        entry(otherUrl, 'Systems Programming', '2025-10-01')
      ],
      hiddenCourses: []
    });
  }, [ACTIVE, OTHER]);

  // currentLectureUrl normally arrives from the content script, which is not
  // in play on a directly-opened page.
  await page.evaluate((url) => {
    currentLectureUrl = url;
    loadHistory();
  }, ACTIVE);

  const active = page.locator('.history-course-group', { hasText: 'Numerical Methods' });
  const other = page.locator('.history-course-group', { hasText: 'Systems Programming' });
  await expect(active).toHaveAttribute('open', '');
  await expect(other).not.toHaveAttribute('open', '');

  // The course is only visible if the year and season above it opened too.
  await expect(page.locator('.history-year-group', { hasText: '2026' })).toHaveAttribute('open', '');
  await expect(page.locator('.history-season-group', { hasText: 'Spring' })).toHaveAttribute('open', '');
  await expect(page.locator('.history-year-group', { hasText: '2025' })).not.toHaveAttribute('open', '');

  await page.evaluate(async () => {
    await chrome.storage.local.remove(['guideHistory', 'hiddenCourses']);
  });
  await page.close();
});
