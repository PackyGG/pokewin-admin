import { test, expect } from "@playwright/test";
import { loadEnvFiles } from "../helpers/env";
import {
  mintCreatorHubSession,
  SESSION_COOKIE_NAME,
} from "../responsive/mint-session";

loadEnvFiles();

test.describe("Creator Hub roster tabs", () => {
  test("Active, Multiplier, and Past tabs render and navigate", async ({
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

    await page.goto("/creator-hub/creators", { waitUntil: "domcontentloaded" });
    expect(page.url()).not.toMatch(/tab=/);

    const tablist = page.getByRole("tablist", { name: "Creator roster" });
    await expect(tablist.getByRole("tab", { name: "Active" })).toBeVisible();
    await expect(tablist.getByRole("tab", { name: "Multiplier" })).toBeVisible();
    await expect(
      tablist.getByRole("tab", { name: "Past Creators" }),
    ).toBeVisible();
    await expect(page.getByText("Active Creators").first()).toBeVisible();

    await page.goto("/creator-hub/creators?tab=multiplier", {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByText("Multiplier Creators").first()).toBeVisible();

    await page.goto("/creator-hub/creators?tab=past", {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByText("Past Creators").first()).toBeVisible();

    await page.goto("/creator-hub/creators", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Active Creators").first()).toBeVisible();

    await context.close();
  });
});
