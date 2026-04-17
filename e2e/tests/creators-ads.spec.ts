import crypto from "node:crypto";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/base";
import { cleanupE2EAdCodes, scratchPrefix } from "../helpers/db";

/**
 * /creators/ads — ad code management.
 *
 * The page has two modes:
 *   - no house account configured → HouseAccountSetup form
 *   - house account configured    → full dashboard with CreateAdCodeButton
 *
 * We verify both, with different assertions each. The create+delete
 * lifecycle only runs when a house account already exists; configuring
 * one requires a real main-DB user and is out of scope for the ads
 * smoke test (the "set house account" flow belongs in its own spec).
 */

async function adsPageState(page: Page): Promise<"setup" | "configured"> {
  // Setup view has a "Pick the house account" header; configured view
  // has a "Create Ad Code" button.
  const hasSetup = await page
    .getByRole("heading", { name: /pick the house account/i })
    .isVisible()
    .catch(() => false);
  return hasSetup ? "setup" : "configured";
}

test.describe("creators / ads", () => {
  test.afterAll(async () => {
    // Sweep any leftover _e2e_ ad codes in case a teardown missed one.
    await cleanupE2EAdCodes();
  });

  test("loads and shows either setup or dashboard", async ({ adminPage }) => {
    await adminPage.goto("/creators/ads");

    await expect(adminPage.getByRole("heading", { name: /^ads$/i })).toBeVisible();

    const state = await adsPageState(adminPage);
    if (state === "setup") {
      await expect(
        adminPage.getByRole("heading", {
          name: /pick the house account/i,
        }),
      ).toBeVisible();
      await expect(
        adminPage.getByPlaceholder(/username, email, or user id/i),
      ).toBeVisible();
    } else {
      // Configured view: aggregate KPI strip is always rendered.
      await expect(
        adminPage.getByText("Codes", { exact: true }).first(),
      ).toBeVisible();
      await expect(
        adminPage.getByText("Total Clicks", { exact: true }),
      ).toBeVisible();
      await expect(
        adminPage.getByRole("button", { name: /create ad code/i }),
      ).toBeVisible();
    }
  });

  test("create → list → delete an ad code (configured only)", async ({
    adminPage,
  }) => {
    await adminPage.goto("/creators/ads");
    const state = await adsPageState(adminPage);
    // Ad-code lifecycle requires a configured house account. Skip
    // loudly with a reason rather than silently passing.
    test.skip(
      state === "setup",
      "house account not configured — skipping lifecycle test",
    );

    // Unique suffix per run — bounded to satisfy the 2-20 char +
    // `[a-zA-Z0-9_-]` constraints in codeSchema.
    const suffix = crypto.randomBytes(3).toString("hex"); // 6 chars
    const code = `${scratchPrefix}${suffix}`.slice(0, 20);

    // Open dialog
    await adminPage
      .getByRole("button", { name: /create ad code/i })
      .click();
    const dialog = adminPage.getByRole("dialog", { name: /create ad code/i });
    await expect(dialog).toBeVisible();

    await dialog.getByLabel(/^code$/i).fill(code);
    await dialog.getByRole("button", { name: /^create$/i }).click();

    // Success toast + dialog closes
    await expect(
      adminPage.getByText(/ad code created/i).first(),
    ).toBeVisible({ timeout: 10_000 });
    await expect(dialog).not.toBeVisible({ timeout: 10_000 });

    // New code appears in the list as a badge — filter by text to be
    // robust against other codes on the page.
    const row = adminPage.locator("tr", { hasText: code });
    await expect(row).toBeVisible({ timeout: 10_000 });

    // Delete via the trash button in that row's action cell.
    await row.getByRole("button", { name: `Delete ${code}` }).click();

    const confirm = adminPage.getByRole("alertdialog", {
      name: /delete ad code/i,
    });
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: /^delete$/i }).click();

    await expect(
      adminPage.getByText(/ad code deleted/i).first(),
    ).toBeVisible({ timeout: 10_000 });

    // Row is gone.
    await expect(adminPage.locator("tr", { hasText: code })).toHaveCount(0);
  });
});
