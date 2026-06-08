import { test, expect } from "../fixtures/base";

/**
 * Edge Plan 2.0 — admin route smoke.
 *
 * Shape-only assertions: page renders past auth, hero + planner shell
 * markers exist, section nav is interactive. No exact numbers — they
 * depend on live DB state.
 */

test.describe("Edge Plan 2.0", () => {
  test("page renders planner shell and section nav", async ({ adminPage }) => {
    const response = await adminPage.goto("/insights/edge-plan-2");
    expect(response?.status()).toBeLessThan(500);

    await expect(
      adminPage.getByRole("heading", { name: /edge plan 2\.0/i }),
    ).toBeVisible();

    await expect(
      adminPage.getByText(/projected profit delta/i),
    ).toBeVisible({ timeout: 15_000 });

    await expect(
      adminPage.getByRole("button", { name: /configs/i }),
    ).toBeVisible();

    await expect(
      adminPage.getByRole("button", { name: /overview/i }).first(),
    ).toBeVisible();
    await expect(
      adminPage.getByRole("button", { name: /shards economy/i }).first(),
    ).toBeVisible();

    await adminPage.getByRole("button", { name: /shards economy/i }).first().click();
    await expect(
      adminPage.getByText("Shards earn", { exact: true }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("shows fixed 30d baseline label", async ({ adminPage }) => {
    await adminPage.goto("/insights/edge-plan-2");

    await expect(
      adminPage.getByText(/last 30 days/i),
    ).toBeVisible();
  });
});
