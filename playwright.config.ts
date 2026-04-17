import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright configuration for the pokewin-admin E2E suite.
 *
 * Ground rules:
 *   - Tests talk to a real dev server spun up by Playwright's `webServer` so
 *     there is zero difference between `npm run dev` and what the tests
 *     exercise. No mocked fetches, no bypass routes.
 *   - Chromium-only for now. Firefox/WebKit parity is fine to add later, but
 *     this codebase only needs to work for internal admins on the browsers
 *     they actually use (Chromium family), so paying the CI minutes for three
 *     browsers would be waste.
 *   - No global retries locally — flakes must be fixed, not hidden. CI gets
 *     two retries because CI hardware is noisier than a local machine.
 *   - Traces are kept cheap (on-first-retry) so every green test has near-
 *     zero overhead while failures still give us a full stepped replay.
 */

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: "./e2e/tests",
  globalSetup: require.resolve("./e2e/global-setup"),
  timeout: 30_000,
  expect: { timeout: 7_500 },

  fullyParallel: false,
  // Writes to the admin DB (creating scratch users, toggling role state,
  // creating ad codes etc.) would stomp on each other across workers. Pin
  // to a single worker so the suite stays deterministic; individual spec
  // files still benefit from Playwright's fixture-level isolation.
  workers: 1,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,

  reporter: isCI
    ? [["github"], ["html", { open: "never" }], ["list"]]
    : [["list"], ["html", { open: "never" }]],

  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    // Force a deterministic viewport so snapshot-style assertions and
    // position-sensitive locators (floating FAB, sticky headers) behave
    // the same on every machine.
    viewport: { width: 1440, height: 900 },
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: {
    // When E2E_USE_EXISTING_SERVER=1 we assume the dev server is already
    // running locally — lets a developer leave `npm run dev` up in another
    // tab and iterate on tests without a cold Next boot every time.
    command: process.env.E2E_USE_EXISTING_SERVER ? "echo reusing existing server" : "npm run dev",
    url: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    reuseExistingServer: !isCI,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
