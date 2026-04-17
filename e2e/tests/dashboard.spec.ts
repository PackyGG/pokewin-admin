import { test, expect } from "../fixtures/base";

/**
 * Dashboard page.
 *
 * We avoid asserting exact numbers — they depend on live DB state and
 * would flake the moment a real admin does anything. Instead we check
 * shape: the right cards exist, the numbers parse as currency/integers,
 * the range swaps on the period-aware cards update the selected chip
 * (and at worst keep the value formatted as currency).
 */

const CURRENCY_RE = /^[+−-]?\$[\d,]+(\.\d{2})?$/;

function extractNumeric(text: string): number {
  const digits = text.replace(/[^\d.-]/g, "");
  return digits ? parseFloat(digits) : 0;
}

test.describe("dashboard", () => {
  test("hero + primary + secondary cards render", async ({ adminPage }) => {
    await adminPage.goto("/dashboard");

    // Hero
    await expect(
      adminPage.getByRole("heading", { name: /dashboard/i }),
    ).toBeVisible();
    await expect(
      adminPage.getByText(/live platform overview/i),
    ).toBeVisible();

    // Primary stat cards — each card exposes its title via a CardTitle
    // element. We assert all five exist so missing a card fails loudly.
    const primary = ["PnL", "GGR", "Total Wager", "Deposits", "Withdrawals"];
    for (const title of primary) {
      await expect(
        adminPage.getByText(title, { exact: true }).first(),
      ).toBeVisible();
    }

    // Each primary card's stat text must look like currency. We hit
    // the PnL card specifically because it's the only one with a
    // stable dollar render (no range selector affecting the DOM).
    const pnlCard = adminPage.locator("div", { hasText: "PnL" }).filter({
      has: adminPage.locator(".text-stat-value"),
    }).first();
    await expect(pnlCard).toBeVisible();
    const pnlText = (await pnlCard.locator(".text-stat-value").innerText()).trim();
    expect(pnlText).toMatch(CURRENCY_RE);

    // Secondary cards — at least "Total Users" and "Avg RTP" must appear.
    await expect(
      adminPage.getByText("Total Users", { exact: true }),
    ).toBeVisible();
    await expect(
      adminPage.getByText("Avg RTP", { exact: true }),
    ).toBeVisible();
  });

  test("Recent Activity section renders", async ({ adminPage }) => {
    await adminPage.goto("/dashboard");
    const section = adminPage.getByRole("heading", {
      name: /recent activity/i,
    });
    await expect(section).toBeVisible();
  });

  test("GGR period swap updates selected chip", async ({ adminPage }) => {
    await adminPage.goto("/dashboard");

    // Narrow to the GGR card — it has the range row inside.
    const ggrCard = adminPage
      .locator("div")
      .filter({ hasText: /^GGR/ })
      .filter({ has: adminPage.locator(".text-stat-value") })
      .first();
    await expect(ggrCard).toBeVisible();

    // The range row contains exactly these buttons (see revenue-stat-card.tsx).
    const ranges = ["24h", "3d", "7d", "30d", "all"];
    for (const r of ranges) {
      await expect(ggrCard.getByRole("button", { name: r })).toBeVisible();
    }

    const btn24h = ggrCard.getByRole("button", { name: "24h" });
    const btn30d = ggrCard.getByRole("button", { name: "30d" });

    // 24h is the initial selection per the component's useState default.
    // The selected button uses `bg-emerald-500/15` / `bg-rose-500/15`.
    await expect(btn24h).toHaveClass(/bg-(emerald|rose)-500\/15/);
    await expect(btn30d).not.toHaveClass(/bg-(emerald|rose)-500\/15/);

    await btn30d.click();
    await expect(btn30d).toHaveClass(/bg-(emerald|rose)-500\/15/);
    await expect(btn24h).not.toHaveClass(/bg-(emerald|rose)-500\/15/);
  });

  test("Deposits period swap keeps currency formatting", async ({
    adminPage,
  }) => {
    await adminPage.goto("/dashboard");

    const card = adminPage
      .locator("div")
      .filter({ hasText: /^Deposits/ })
      .filter({ has: adminPage.locator(".text-stat-value") })
      .first();
    await expect(card).toBeVisible();

    const value = card.locator(".text-stat-value");
    const before = (await value.innerText()).trim();
    expect(before).toMatch(CURRENCY_RE);

    // Swap to "all" — the card re-renders the value from stats.deposits.all.
    await card.getByRole("button", { name: "all" }).click();

    // The number may or may not change depending on the DB state, but it
    // must still parse as currency and the selected chip must move. The
    // AnimatedNumber component transitions, so give it a beat to settle.
    await expect(card.getByRole("button", { name: "all" })).toHaveClass(
      /bg-emerald-500\/15/,
    );
    const after = (await value.innerText()).trim();
    expect(after).toMatch(CURRENCY_RE);

    // Sanity — at least verify the extracted number is finite.
    expect(Number.isFinite(extractNumeric(after))).toBe(true);
  });
});
