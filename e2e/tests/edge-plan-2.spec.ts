import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../fixtures/base";

/**
 * Edge Plan 2.0 — v2.1 overhaul contract tests (2026-06-12).
 *
 * Two surfaces are exercised:
 *
 *   1. The LIVE admin route /insights/edge-plan-2 — auth-gated; we only assert
 *      DB-independent chrome (the PageHero heading + the fixed 30d baseline
 *      label). The planner body itself can render empty/sparse against a main
 *      DB behind the current Prisma schema, so data-dependent markers are NOT
 *      asserted there.
 *
 *   2. The DEV-ONLY rendering fixture /responsive-fixture/edge-plan-2 — renders
 *      the EXACT production <EdgePlanV2Planner> with a deterministic baseline
 *      (see src/app/responsive-fixture/edge-plan-2/fixture-client.tsx) that
 *      populates EVERY v2.1 block. Against it we pin the overhaul's plan
 *      verification list:
 *        • raw math edge chip reads 10.50% at the planning defaults,
 *        • raffles = ONE keep-slider; the old ×-multiplier sliders are gone,
 *        • deposit-fee coin chips react (USDT exempt by default) and the fee
 *          math is exact (+$5,500.00 at 2% of the $275k non-USDT volume),
 *        • direct $ inputs react (profit delta leaves $0),
 *        • the NULL "Not itemized" adjustment bucket is visible,
 *        • shards: 10-row case table (Starter Kit $0.12 … Eternal Fortune
 *          $600.00) + 0.300%-of-wager giveback at the spec defaults,
 *        • crediting matrix: editing a cell moves the savings/profit,
 *        • withdrawal worked example: $200 of wager at 50% upgrader weight.
 *
 *   The fixture route sits OUTSIDE the (admin) group (no page-access grant
 *   needed) but is still behind middleware auth, so we reach it through the
 *   authenticated `adminPage` fixture. It 404s in production, so this only
 *   runs in dev/CI.
 *
 * Exact-number assertions are used ONLY where the fixture pins them
 * deterministically (fee math, shard case values, worked example); everything
 * else stays shape-based so live-DB drift can't break the suite.
 */

const FIXTURE_PATH = "/responsive-fixture/edge-plan-2";

/** Tailwind text-tone classes used for the house net-edge value. */
const NET_EDGE_TONE_CLASS = /text-(emerald|rose|amber)-(700|600|400|300)/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function gotoFixture(page: Page): Promise<void> {
  const response = await page.goto(FIXTURE_PATH);
  expect(response?.status()).toBeLessThan(500);
  // Auth-gated fixture: a redirect to /login means the session cookie was
  // rejected — fail loud rather than asserting against the login page.
  expect(new URL(page.url()).pathname).toBe(FIXTURE_PATH);
  // The planner is mounted once the hero profit panel renders.
  await expect(
    page.getByText(/projected profit delta/i).first(),
  ).toBeVisible({ timeout: 15_000 });
}

/**
 * Open one of the seven lever workspaces by its rail/pill label. The rail
 * renders TWICE (vertical rail on lg+, scroll pills below lg) — only one nav
 * is visible at any viewport, so click the first VISIBLE match.
 */
async function openGroup(page: Page, name: RegExp): Promise<void> {
  const buttons = page.getByRole("button", { name });
  const count = await buttons.count();
  for (let i = 0; i < count; i++) {
    const btn = buttons.nth(i);
    if (await btn.isVisible()) {
      await btn.click();
      return;
    }
  }
  throw new Error(`No visible workspace nav button matching ${String(name)}`);
}

/** The hero "Projected profit delta" $ value (AnimatedNumber output). */
function profitValue(page: Page): Locator {
  return page
    .locator("div")
    .filter({ has: page.getByText("Projected profit delta", { exact: true }) })
    .locator("p.text-3xl")
    .first();
}

/** Commit a value into a planner text input (commit on Enter + blur). */
async function commitInput(input: Locator, value: string): Promise<void> {
  await input.click();
  await input.fill(value);
  await input.press("Enter");
}

// ---------------------------------------------------------------------------
// Live route chrome (DB-independent)
// ---------------------------------------------------------------------------

test.describe("Edge Plan 2.0 — live route chrome", () => {
  test("renders the page hero", async ({ adminPage }) => {
    const response = await adminPage.goto("/insights/edge-plan-2");
    expect(response?.status()).toBeLessThan(500);

    await expect(
      adminPage.getByRole("heading", { name: /edge plan 2\.0/i }),
    ).toBeVisible();
  });

  test("shows the fixed 30d baseline label", async ({ adminPage }) => {
    await adminPage.goto("/insights/edge-plan-2");

    await expect(adminPage.getByText(/last 30 days/i).first()).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Planner contract (deterministic fixture)
// ---------------------------------------------------------------------------

test.describe("Edge Plan 2.0 — planner contract (fixture)", () => {
  test("mounts at $0 profit delta with a Measured 30d strip and a colored net edge", async ({
    adminPage,
  }) => {
    await gotoFixture(adminPage);

    // Default-zero invariant: every lever seeds from its run-rate.
    await expect(profitValue(adminPage)).toHaveText("$0.00", {
      timeout: 15_000,
    });

    // The clearly-labeled measured block (baseline.canonical) renders
    // SEPARATELY from the planning numbers (Bug-B fix contract).
    await expect(
      adminPage.getByText(/measured 30d/i).first(),
    ).toBeVisible();

    // The net-edge readout is actually COLORED (house-POV tone classes).
    const coloredNetEdge = adminPage
      .locator(
        '[class*="text-emerald-"], [class*="text-rose-"], [class*="text-amber-"]',
      )
      .filter({ hasText: /%/ })
      .first();
    await expect(coloredNetEdge).toBeVisible({ timeout: 15_000 });
    const cls = (await coloredNetEdge.getAttribute("class")) ?? "";
    expect(cls).toMatch(NET_EDGE_TONE_CLASS);
  });

  test("raw math edge chip reads 10.50% at the planning defaults", async ({
    adminPage,
  }) => {
    await gotoFixture(adminPage);
    // "House edge" (gaming) is the default workspace — the dual readout is
    // already on screen: mean(10.99%, 10%) = 10.495% → rendered "10.50%".
    await expect(
      adminPage.getByText("Raw math edge", { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(adminPage.getByText("10.50%").first()).toBeVisible();
    // Both figures stay labeled — the wager-weighted twin is present too.
    await expect(
      adminPage.getByText("Wager-weighted edge", { exact: true }),
    ).toBeVisible();
  });

  test("raffles: ONE keep-slider; the old ×-multiplier sliders are gone", async ({
    adminPage,
  }) => {
    await gotoFixture(adminPage);
    await openGroup(adminPage, /giveaways/i);

    await expect(
      adminPage.getByText("Keep raffles at").first(),
    ).toBeVisible({ timeout: 15_000 });

    // The three v1 raffle multiplier levers (Prize pool × / Frequency × /
    // Ticket cost ×) were deleted, not hidden.
    await expect(adminPage.getByText(/prize pool/i)).toHaveCount(0);
    await expect(adminPage.getByText(/ticket cost/i)).toHaveCount(0);
  });

  test("adjustments box shows the NULL 'Not itemized' bucket", async ({
    adminPage,
  }) => {
    await gotoFixture(adminPage);
    await openGroup(adminPage, /giveaways/i);

    // The fixture's adjustmentBreakdown carries a category:null row.
    await expect(
      adminPage.getByText("Not itemized").first(),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("direct $ inputs react: committing a budget moves the profit delta off $0", async ({
    adminPage,
  }) => {
    await gotoFixture(adminPage);
    const profit = profitValue(adminPage);
    await expect(profit).toHaveText("$0.00", { timeout: 15_000 });

    await openGroup(adminPage, /giveaways/i);

    // Prefer a monthly-$ budget box (PlannerBudgetInput aria-label
    // "<label> exact value"); fall back to any precise planner input in the
    // workspace. Committing "0" is guaranteed to move the projection for
    // every input shape here (budget → $0 cost, keep-% → raffles off, …).
    const preferred = adminPage.locator(
      'input[aria-label*="monthly" i], input[aria-label*="budget" i]',
    );
    const fallback = adminPage.locator('input[aria-label$="exact value"]');
    const input = (await preferred.count()) > 0
      ? preferred.first()
      : fallback.first();
    await expect(input).toBeVisible({ timeout: 15_000 });

    await commitInput(input, "0");
    await expect(input).toHaveValue("0");
    await expect(profit).not.toHaveText("$0.00", { timeout: 10_000 });
  });

  test("deposit fee: exact revenue math + coin chips react (USDT exempt by default)", async ({
    adminPage,
  }) => {
    await gotoFixture(adminPage);
    await openGroup(adminPage, /deposits & withdrawals|cashflow/i);

    // USDT-family chips start UNSELECTED (exempt by default).
    const usdtChips = adminPage.getByRole("button", { name: /usdt/i });
    const usdtCount = await usdtChips.count();
    expect(usdtCount).toBeGreaterThanOrEqual(2); // USDT + USDT_TRON
    for (let i = 0; i < usdtCount; i++) {
      await expect(usdtChips.nth(i)).toHaveAttribute("aria-pressed", "false");
    }

    // 2% fee on the default (non-USDT) $275,000 volume = exactly $5,500.
    await commitInput(
      adminPage.getByLabel("Deposit fee exact value"),
      "2",
    );
    await expect(
      adminPage.getByText("+$5,500.00").first(),
    ).toBeVisible({ timeout: 10_000 });

    // Untick BTC ($120k) → the fee re-prices to 2% × $155,000 = $3,100.
    const btcChip = adminPage.getByRole("button", { name: /btc/i }).first();
    await expect(btcChip).toHaveAttribute("aria-pressed", "true");
    await btcChip.click();
    await expect(btcChip).toHaveAttribute("aria-pressed", "false");
    await expect(
      adminPage.getByText("+$3,100.00").first(),
    ).toBeVisible({ timeout: 10_000 });

    // And the revenue is profit-positive: the hero leaves $0 (emerald side).
    await expect(profitValue(adminPage)).not.toHaveText("$0.00", {
      timeout: 10_000,
    });
  });

  test("shards: 10-row case table re-priced from EV + 0.300% giveback at spec defaults", async ({
    adminPage,
  }) => {
    await gotoFixture(adminPage);
    await openGroup(adminPage, /shards/i);

    // The fixed shard-shop ladder renders even while the program is OFF:
    // 1 header row + 10 case rows, value = shards × $0.06.
    await expect(adminPage.getByRole("row")).toHaveCount(11, {
      timeout: 15_000,
    });
    await expect(
      adminPage.getByRole("cell", { name: "Starter Kit" }),
    ).toBeVisible();
    await expect(adminPage.getByText("$0.12").first()).toBeVisible();
    await expect(
      adminPage.getByRole("cell", { name: "Eternal Fortune" }),
    ).toBeVisible();
    await expect(adminPage.getByText("$600.00").first()).toBeVisible();

    // Default OFF → $0 cost → profit delta still $0.
    await expect(profitValue(adminPage)).toHaveText("$0.00");

    // Toggle ON at the spec defaults ($20/shard, $0.06 EV, full weights) →
    // the effective giveback sits EXACTLY on the 0.30% target.
    await adminPage
      .getByRole("switch", { name: "Enable shard program" })
      .click();
    await expect(
      adminPage.getByText(/0\.300% of wager/).first(),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      adminPage.getByText(/target 0\.30%/).first(),
    ).toBeVisible();
    // Shards now cost money → profit delta goes negative (house pays).
    await expect(profitValue(adminPage)).not.toHaveText("$0.00", {
      timeout: 10_000,
    });
  });

  test("crediting matrix: editing a cell moves the savings / profit delta", async ({
    adminPage,
  }) => {
    await gotoFixture(adminPage);
    const profit = profitValue(adminPage);
    await expect(profit).toHaveText("$0.00", { timeout: 15_000 });

    await openGroup(adminPage, /crediting matrix|matrix/i);

    // All cells default to 100% credit → $0 savings. Dropping ANY cell below
    // 100 creates savings (a cost REDUCTION → profit moves ABOVE $0).
    //
    // The matrix section exposes the stable data-testid="credit-matrix-cell"
    // hook (sections/credit-matrix.tsx) — the first candidate picks it up;
    // the row-scoped and generic fallbacks stay as resilience. Note: cells in
    // the shards COLUMN have rate 0 while the shard program is OFF (the
    // default), so the loop restores any cell that doesn't move the profit
    // and keeps trying until one does.
    const candidates: Locator[] = [
      adminPage
        .locator(
          '[data-testid^="credit-matrix"] input, input[data-testid^="credit-matrix"], [data-testid^="matrix-cell"] input, input[data-testid^="matrix-cell"]',
        ),
      adminPage
        .getByRole("row", { name: /rain wins|race prizes|rakeback/i })
        .first()
        .locator("input"),
      adminPage.locator('input[aria-label*="credit" i]'),
      adminPage.locator(
        'input[inputmode="decimal"], input[type="number"]',
      ),
    ];

    let moved = false;
    for (const candidate of candidates) {
      const count = await candidate.count();
      for (let i = 0; i < count && !moved; i++) {
        const input = candidate.nth(i);
        if (!(await input.isVisible().catch(() => false))) continue;
        const original = await input.inputValue().catch(() => null);
        await commitInput(input, "0");
        try {
          await expect(profit).not.toHaveText("$0.00", { timeout: 3_000 });
          moved = true;
        } catch {
          // Wrong knob (e.g. the re-wager assumption at all-100 cells does
          // nothing) — restore it so later candidates stay meaningful.
          if (original != null) await commitInput(input, original);
        }
      }
      if (moved) break;
    }
    expect(
      moved,
      "editing a crediting-matrix cell must move the savings/profit delta",
    ).toBe(true);
  });

  test("withdrawal worked example: $200 of wager at 50% upgrader weight", async ({
    adminPage,
  }) => {
    await gotoFixture(adminPage);
    await openGroup(adminPage, /deposits & withdrawals|cashflow/i);

    // Defaults: $100 example deposit at 100% weights → both modes show $100.
    await expect(
      adminPage.getByText("Worked example").first(),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      adminPage.getByText("wager $100.00").first(),
    ).toBeVisible();

    // Drag the upgrader weight to 50% (ArrowLeft on the Radix slider thumb —
    // step 1, from 100). The LeverSlider root carries the aria-label; the
    // keyboard target is the thumb (role=slider) inside the labeled control.
    const upgraderControl = adminPage
      .locator("div.space-y-1\\.5")
      .filter({
        has: adminPage.getByText("Upgrader wager weight", { exact: true }),
      })
      .first();
    const thumb = upgraderControl.getByRole("slider").first();
    await thumb.click(); // focus the thumb
    for (let i = 0; i < 60; i++) {
      const now = await thumb.getAttribute("aria-valuenow");
      if (now === "50") break;
      await adminPage.keyboard.press("ArrowLeft");
    }
    await expect(thumb).toHaveAttribute("aria-valuenow", "50");

    // deposit $100 ÷ 0.5 weight = $200 of upgrader wager (2× the deposit).
    await expect(adminPage.getByText("50% weight").first()).toBeVisible();
    await expect(
      adminPage.getByText("wager $200.00").first(),
    ).toBeVisible({ timeout: 10_000 });
  });
});
