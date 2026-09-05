/**
 * Playwright is used for one thing: proving the extension loads in a real
 * Chrome. Everything testable in Node is tested in Jest, which is far faster.
 *
 * Extensions need a persistent context and a real browser, so these do not run
 * headless-shell — hence the separate runner and the xvfb step in CI.
 */
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.js',
  // Loading an unpacked extension takes a few seconds on a cold profile.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // One at a time: each test shares the one browser with the extension in it.
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: {
    trace: process.env.CI ? 'retain-on-failure' : 'off',
    screenshot: 'only-on-failure'
  }
});
