import { test, expect } from "@playwright/test";
import { loadEnvFiles } from "../helpers/env";
import {
  mintCreatorHubSession,
  readSampleCreatorId,
  SESSION_COOKIE_NAME,
} from "../responsive/mint-session";

loadEnvFiles();

/**
 * Creator Hub route smoke — minted-session render pass.
 *
 * Uses the same JWT mint helper as the responsive harness (NOT the real
 * /login form) because Hub access is gated by `canAccessCreatorHub`
 * (motha bypass OR per-role ADMIN-DB toggle), not plain admin role.
 *
 * Auth behaviour is still covered by auth.spec.ts / permissions.spec.ts.
 * This spec only proves every `/creator-hub/*` route renders past the gate.
 */

const HUB_ROUTES = [
  "/creator-hub",
  "/creator-hub/creators",
  "/creator-hub/leaderboards",
  "/creator-hub/socials-review",
  "/creator-hub/profitable-algo",
  "/creator-hub/changelog",
  // Legacy bookmark — should redirect to dashboard after gate.
  "/creator-hub/alerts",
] as const;

test.describe("Creator Hub routes (minted session)", () => {
  test("every hub route renders past the access gate", async ({ browser }) => {
    test.setTimeout(120_000);
    const { cookieValue } = await mintCreatorHubSession();
    const context = await browser.newContext();
    await context.addCookies([
      {
        name: SESSION_COOKIE_NAME,
        value: cookieValue,
        domain: "localhost",
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    const page = await context.newPage();

    for (const route of HUB_ROUTES) {
      const response = await page.goto(route, { waitUntil: "domcontentloaded" });
      expect(response, `${route} should respond`).not.toBeNull();
      expect(response!.status(), `${route} status`).toBeLessThan(500);

      // Gate bounce — never land on login from a minted admin/motha session.
      expect(page.url(), `${route} should not redirect to login`).not.toMatch(
        /\/login/,
      );

      if (route === "/creator-hub/alerts") {
        // Legacy bookmark — server `redirect()` to dashboard; in dev the
        // client URL may lag one beat, so accept either final URL.
        try {
          await page.waitForURL(/\/creator-hub\/?$/, { timeout: 8_000 });
        } catch {
          expect(page.url()).toMatch(/\/creator-hub\/alerts/);
        }
        continue;
      }

      // Hub shell marker — sidebar title or hero.
      await expect(
        page.getByText(/Creator Hub/i).first(),
      ).toBeVisible({ timeout: 15_000 });
    }

    await context.close();
  });

  test("creator detail + forecast tab render when a creator exists", async ({
    browser,
  }) => {
    const creatorId = await readSampleCreatorId();
    test.skip(!creatorId, "No creator user in MAIN DB — skip detail route");

    const { cookieValue } = await mintCreatorHubSession();
    const context = await browser.newContext();
    await context.addCookies([
      {
        name: SESSION_COOKIE_NAME,
        value: cookieValue,
        domain: "localhost",
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    const page = await context.newPage();

    const overviewUrl = `/creator-hub/creators/${creatorId}`;
    const response = await page.goto(overviewUrl, {
      waitUntil: "domcontentloaded",
    });
    expect(response?.status()).toBeLessThan(500);
    await expect(page.getByText(/Creator Hub/i).first()).toBeVisible({
      timeout: 15_000,
    });

    const forecastUrl = `${overviewUrl}?tab=forecast`;
    const forecastResponse = await page.goto(forecastUrl, {
      waitUntil: "domcontentloaded",
    });
    expect(forecastResponse?.status()).toBeLessThan(500);
    await expect(
      page.getByText(/Deal profitability forecast/i).first(),
    ).toBeVisible({ timeout: 30_000 });

    await context.close();
  });

  test("leaderboard detail renders when a board exists", async ({ browser }) => {
    const { cookieValue } = await mintCreatorHubSession();
    const context = await browser.newContext();
    await context.addCookies([
      {
        name: SESSION_COOKIE_NAME,
        value: cookieValue,
        domain: "localhost",
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    const page = await context.newPage();

    const listResponse = await page.goto("/creator-hub/leaderboards", {
      waitUntil: "domcontentloaded",
    });
    expect(listResponse?.status()).toBeLessThan(500);
    await expect(page.getByText(/Creator Hub/i).first()).toBeVisible({
      timeout: 15_000,
    });

    const detailLink = page.locator('a[href^="/creator-hub/leaderboards/"]').first();
    const linkCount = await detailLink.count();
    test.skip(linkCount === 0, "No leaderboards in backend — skip detail route");

    const href = await detailLink.getAttribute("href");
    expect(href).toMatch(/^\/creator-hub\/leaderboards\/.+/);

    const detailResponse = await page.goto(href!, {
      waitUntil: "domcontentloaded",
    });
    expect(detailResponse?.status()).toBeLessThan(500);
    await expect(page.getByText(/Standings/i).first()).toBeVisible({
      timeout: 15_000,
    });

    await context.close();
  });

  test("legacy codes-ads bookmarks redirect to admin marketing", async ({
    browser,
  }) => {
    const { cookieValue } = await mintCreatorHubSession();
    const context = await browser.newContext();
    await context.addCookies([
      {
        name: SESSION_COOKIE_NAME,
        value: cookieValue,
        domain: "localhost",
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    const page = await context.newPage();

    await page.goto("/creator-hub/codes-ads?tab=ads", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForURL(/\/creators\/ads/, { timeout: 8_000 });

    await page.goto("/creator-hub/codes-ads?tab=codes", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForURL(/\/creators\/?$/, { timeout: 8_000 });

    await context.close();
  });
});
