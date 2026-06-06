import { defineConfig, devices } from "@playwright/test";

/**
 * Dedicated Playwright config for the RESPONSIVE audit harness
 * (e2e/responsive/**). Kept separate from the main playwright.config.ts
 * (which drives the auth-based behaviour suite in e2e/tests/**) because:
 *
 *   - The responsive harness authenticates via a minted session cookie
 *     (see e2e/responsive/mint-session.ts) rather than the real login
 *     form, so it doesn't need (and shouldn't share) the auth fixtures.
 *   - It runs hundreds of navigations (routes × viewports) and needs a
 *     much longer per-test timeout than the 30s behaviour-test budget.
 *   - Screenshots are intrinsic to its output, not failure-only.
 *
 * Run with:  npx playwright test --config=playwright.responsive.config.ts
 *
 * Creator Hub sweep:
 *   RESPONSIVE_EXPECT_CLEAN=1 npx playwright test --config=playwright.responsive.config.ts creator-hub-audit
 */

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: "./e2e/responsive",
  testMatch: /.*\.spec\.ts$/,
  // Reuse the same env-loading + stale-user sweep as the behaviour suite.
  globalSetup: require.resolve("./e2e/global-setup"),
  // A single route's full viewport matrix (10–13 widths, each a fresh nav +
  // full-page screenshot) comfortably exceeds the 30s behaviour budget.
  timeout: 300_000,
  expect: { timeout: 10_000 },

  fullyParallel: false,
  workers: 1,
  forbidOnly: isCI,
  retries: 0,

  reporter: [["list"]],

  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "off",
    // The harness captures its own annotated full-page screenshots into
    // audit-artifacts/; Playwright's failure screenshots would be redundant.
    screenshot: "off",
    video: "off",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: {
    command: process.env.E2E_USE_EXISTING_SERVER
      ? "echo reusing existing server"
      : "npm run dev",
    url: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    reuseExistingServer: !isCI,
    timeout: 240_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
