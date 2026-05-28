import { defineConfig, devices } from '@playwright/test';

const isCI = !!process.env.CI;

export default defineConfig({
  // Look for test files relative to the project root
  testDir: '.',

  // Tests run sequentially locally (so users can watch the browser);
  // in CI we parallelize to keep the pipeline fast.
  fullyParallel: isCI,
  workers: isCI ? 2 : 1,

  // Fail the build on CI if you accidentally left test.only
  forbidOnly: isCI,

  // Retry strategy. Locally we now retry up to 2 times because the
  // most common test failure during development is a transient locator
  // timeout (cold-start animations, slow first navigation) that succeeds
  // on a second attempt. CI gets 2 retries to absorb flaky network too.
  retries: 2,

  // Per-test timeout. The default 30s is too tight when the first headed-mode
  // run also has to wait for a real browser window to appear; bump to 90s so
  // beforeEach/afterEach hooks don't trip on saucedemo-style login flows.
  timeout: 90_000,
  expect: {
    // Single assertion budget — used by toHaveText/toBeVisible etc.
    timeout: 15_000,
  },

  // Reporter
  reporter: [
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['list'],
    // Self-healing capture: writes <spec>.failure-<test>.json sidecars on
    // failure so /api/run-playwright can drive an LLM healing pass.
    // CJS (.cjs) not TS — Playwright's reporter loader couldn't pick up
    // the .ts version reliably in this ESM project, leaving every run
    // with "No failure sidecars found".
    ['./backend/healing-reporter.cjs'],
    // JUnit XML is the format most CI dashboards (GitHub Actions, GitLab, etc.) understand.
    ...(isCI ? [['junit', { outputFile: 'test-results/junit.xml' }] as ['junit', { outputFile: string }]] : []),
  ],

  use: {
    // Headless in CI (no display server), headed locally so users can watch.
    headless: isCI,

    // Collect traces on first retry
    trace: 'on-first-retry',

    // Screenshot on failure
    screenshot: 'only-on-failure',

    // Video recording
    video: 'retain-on-failure',

    // Viewport
    viewport: { width: 1280, height: 720 },

    // Action timeout
    actionTimeout: 15000,

    // Navigation timeout
    navigationTimeout: 30000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  
  // Output directory for test artifacts
  outputDir: 'test-results/',
});
