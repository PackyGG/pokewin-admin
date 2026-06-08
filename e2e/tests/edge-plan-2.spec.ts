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
    ).toBeVisible();

    // Section nav tabs — at least overview + shards economy.
    await expect(
      adminPage.getByRole("button", { name: /overview/i }).first(),
    ).toBeVisible();
    await expect(
      adminPage.getByRole("button", { name: /shards economy/i }).first(),
    ).toBeVisible();

    // Switch to Shards tab — panel should expose shard economy copy.
    await adminPage.getByRole("button", { name: /shards economy/i }).first().click();
    await expect(
      adminPage.getByText("Shards earn", { exact: true }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("period query param accepted", async ({ adminPage }) => {
    const response = await adminPage.goto("/insights/edge-plan-2?period=30d");
    expect(response?.status()).toBeLessThan(500);

    await expect(
      adminPage.getByRole("heading", { name: /edge plan 2\.0/i }),
    ).toBeVisible();
    await expect(
      adminPage.getByText(/baseline window/i),
    ).toBeVisible();
  });
});
