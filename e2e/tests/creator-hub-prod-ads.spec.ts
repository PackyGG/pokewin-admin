import { test, expect } from "@playwright/test";
import { loadEnvFiles } from "../helpers/env";
import {
  mintCreatorHubSession,
  readSampleAdCode,
  SESSION_COOKIE_NAME,
} from "../responsive/mint-session";

loadEnvFiles();

/**
 * Prod smoke for hub ads detail — run with:
 *   E2E_BASE_URL=https://pokewin-admin.vercel.app npx playwright test e2e/tests/creator-hub-prod-ads.spec.ts
 */
async function hubContext(browser: import("@playwright/test").Browser, baseURL: string) {
  const host = new URL(baseURL).hostname;
  const { cookieValue } = await mintCreatorHubSession();
  const context = await browser.newContext({ baseURL });
  await context.addCookies([
    {
      name: SESSION_COOKIE_NAME,
      value: cookieValue,
      domain: host,
      path: "/",
      httpOnly: true,
      secure: host !== "localhost",
      sameSite: "Lax",
    },
  ]);
  return context;
}

test.describe("Creator Hub ads (prod smoke)", () => {
  test("codes-ads ads tab renders past hub gate", async ({ browser, baseURL }) => {
    test.setTimeout(120_000);
    const context = await hubContext(browser, baseURL!);
    const page = await context.newPage();

    const listResponse = await page.goto("/creator-hub/codes-ads?tab=ads", {
      waitUntil: "domcontentloaded",
    });
    expect(listResponse?.status()).toBeLessThan(500);
    expect(page.url()).not.toMatch(/\/login/);
    await expect(page.getByText(/Creator Hub/i).first()).toBeVisible({
      timeout: 20_000,
    });
    // Ads tab content or house-setup empty state — both prove the route works.
    const adsReady = await page
      .getByText(/Campaign Codes|Pick the house account/i)
      .first()
      .isVisible({ timeout: 20_000 })
      .catch(() => false);
    expect(adsReady).toBe(true);

    await context.close();
  });

  test("hub ad detail route stays on hub (not legacy admin)", async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(120_000);
    const adCode = await readSampleAdCode();
    const context = await hubContext(browser, baseURL!);
    const page = await context.newPage();

    if (adCode) {
      const detailResponse = await page.goto(
        `/creator-hub/codes-ads/ads/${encodeURIComponent(adCode)}`,
        { waitUntil: "domcontentloaded" },
      );
      expect(detailResponse?.status()).toBeLessThan(500);
      expect(page.url()).toMatch(/\/creator-hub\/codes-ads\/ads\//);
      expect(page.url()).not.toMatch(/\/creators\/ads\//);
      await expect(page.getByText(adCode).first()).toBeVisible({
        timeout: 20_000,
      });
      await expect(page.getByText(/Wager Source/i).first()).toBeVisible({
        timeout: 20_000,
      });
    } else {
      // No house code in connected DB — still verify route exists and 404s cleanly.
      const detailResponse = await page.goto(
        "/creator-hub/codes-ads/ads/__e2e_missing__",
        { waitUntil: "domcontentloaded" },
      );
      expect(detailResponse?.status()).toBe(404);
      expect(page.url()).not.toMatch(/\/creators\/ads\//);
    }

    await context.close();
  });
});
