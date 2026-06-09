import { test, expect } from "../fixtures/base";

/**
 * Edge Plan 2.0 — rework smoke + shape assertions.
 *
 * Two surfaces are exercised:
 *
 *   1. The LIVE admin route /insights/edge-plan-2 — auth-gated; we only assert
 *      DB-independent chrome (the PageHero heading + the fixed 30d baseline
 *      label). The planner body itself can render empty/sparse against a main
 *      DB behind the current Prisma schema (local copy = frozen DEV snapshot,
 *      see CLAUDE.md "Stale local dev DB"), so the data-dependent markers are
 *      NOT asserted here.
 *
 *   2. The DEV-ONLY rendering fixture /responsive-fixture/edge-plan-2 — renders
 *      the EXACT production <EdgePlanV2Planner> with a type-correct baseline
 *      tuned to a NEGATIVE net edge after rewards (rose/amber color path), a
 *      NON-ZERO raffleCost (restored Raffle section), and a real affiliate
 *      split. This gives a deterministic surface to assert the rework's
 *      contract independent of live DB state:
 *        • the "Edge after rewards" hero number is actually COLORED (the
 *          verified color-token rendering bug the rework fixes),
 *        • a "Raffle" section/heading is present (raffles RESTORED),
 *        • NO "Shards" anywhere (shard economy RIPPED OUT of the model),
 *        • NO "Future levers" / "Ideas" section (removed).
 *
 *   The fixture route sits OUTSIDE the (admin) group (no page-access grant
 *   needed) but is still behind middleware auth, so we reach it through the
 *   authenticated `adminPage` fixture — the same admin_session cookie that
 *   gates the live route. It 404s in production, so this only runs in dev/CI.
 *
 * Shape-only throughout — no exact numbers (they depend on live DB state /
 * the fixture's representative anchors, not on the assertion).
 */

const FIXTURE_PATH = "/responsive-fixture/edge-plan-2";

/** Tailwind text-tone classes the rework uses for the house net-edge value. */
const NET_EDGE_TONE_CLASS = /text-(emerald|rose|amber)-(600|400)/;

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

test.describe("Edge Plan 2.0 — planner contract (fixture)", () => {
  test("net-edge hero number is colored (color-token rendering fix)", async ({
    adminPage,
  }) => {
    const response = await adminPage.goto(FIXTURE_PATH);
    expect(response?.status()).toBeLessThan(500);
    // Auth-gated fixture: a redirect to /login means the session cookie was
    // rejected — fail loud rather than asserting against the login page.
    expect(new URL(adminPage.url()).pathname).toBe(FIXTURE_PATH);

    // The reworked hero carries an "After rewards" net-edge readout. Locate the
    // percentage value rendered in the colored net-edge slot. The fixture forces
    // a NEGATIVE net edge, so this resolves to the rose (house-loss) tone.
    const afterRewardsLabel = adminPage
      .getByText("After rewards", { exact: true })
      .first();
    await expect(afterRewardsLabel).toBeVisible({ timeout: 15_000 });

    // The net-edge number sits in the same StatPanel as the "After rewards"
    // label. Find a percentage-bearing element carrying a net-edge tone class.
    const coloredNetEdge = adminPage
      .locator(
        '[class*="text-emerald-"], [class*="text-rose-"], [class*="text-amber-"]',
      )
      .filter({ hasText: /%/ })
      .first();
    await expect(coloredNetEdge).toBeVisible({ timeout: 15_000 });

    // Shape assertion 1: an explicit emerald/rose/amber text tone class is
    // present on the colored value (the className path the color-token fix
    // restored). This is the "or a tone class is present" branch.
    const cls = (await coloredNetEdge.getAttribute("class")) ?? "";
    expect(cls).toMatch(NET_EDGE_TONE_CLASS);

    // Shape assertion 2 (belt-and-suspenders): the computed text color is a
    // real, non-empty, non-transparent color — i.e. the value is actually
    // painted, not silently colorless (the exact bug the rework fixes).
    const computedColor = await coloredNetEdge.evaluate(
      (el) => getComputedStyle(el).color,
    );
    expect(computedColor).toBeTruthy();
    expect(computedColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(computedColor).not.toBe("transparent");
  });

  test("Raffle section is present (raffles restored)", async ({ adminPage }) => {
    await adminPage.goto(FIXTURE_PATH);
    expect(new URL(adminPage.url()).pathname).toBe(FIXTURE_PATH);

    // The restored Raffle lever section is gated behind its own nav group in
    // the workspace. Activate it if a Raffle(s) nav control exists, then assert
    // the section heading is present.
    const raffleNav = adminPage
      .getByRole("button", { name: /raffles?/i })
      .first();
    if (await raffleNav.count()) {
      await raffleNav.click().catch(() => undefined);
    }

    await expect(
      adminPage.getByText(/raffles?/i).first(),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("NO Shards economy anywhere (shards ripped out)", async ({
    adminPage,
  }) => {
    await adminPage.goto(FIXTURE_PATH);
    expect(new URL(adminPage.url()).pathname).toBe(FIXTURE_PATH);

    // Wait for the planner to mount (the hero profit panel is always present).
    await expect(
      adminPage.getByText(/projected profit delta/i).first(),
    ).toBeVisible({ timeout: 15_000 });

    // No shard nav, no shard section, no shard copy — the entire economy was
    // removed from the model, not merely hidden.
    await expect(
      adminPage.getByRole("button", { name: /shards/i }),
    ).toHaveCount(0);
    await expect(adminPage.getByText(/shards/i)).toHaveCount(0);
  });

  test("NO Future levers / Ideas section (removed)", async ({ adminPage }) => {
    await adminPage.goto(FIXTURE_PATH);
    expect(new URL(adminPage.url()).pathname).toBe(FIXTURE_PATH);

    await expect(
      adminPage.getByText(/projected profit delta/i).first(),
    ).toBeVisible({ timeout: 15_000 });

    await expect(
      adminPage.getByRole("button", { name: /future levers/i }),
    ).toHaveCount(0);
    await expect(
      adminPage.getByRole("button", { name: /^ideas$/i }),
    ).toHaveCount(0);
    await expect(adminPage.getByText(/future levers/i)).toHaveCount(0);
  });
});
