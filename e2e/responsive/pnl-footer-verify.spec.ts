import { test, expect, type Page } from "@playwright/test";
import { mintAdminSession, SESSION_COOKIE_NAME } from "./mint-session";

/**
 * Render-verify for the Platform-P&L footer chips (24h / 7d).
 *
 * Asserts:
 *   1. The two compact chips ("24h" + "7d") render at the BOTTOM of the
 *      Platform P&L panel.
 *   2. The Platform-P&L box did NOT grow — its height does NOT exceed its
 *      Balances / Activity siblings in the equal-height 3-up grid (they
 *      share one row height; P&L must not be the tallest).
 *   3. Mobile (390px) still stacks the three panels vertically.
 *
 * Renders the dev-only fixture (no DB / auth needed):
 *   /responsive-fixture/users-detail  (Overview tab is the default).
 */

const FIXTURE = "/responsive-fixture/users-detail";

// Outer panel root for a StatPanel given its title text.
function panelRoot(page: Page, title: string) {
  return page
    .locator('div.rounded-2xl.border', {
      has: page.locator("h3", { hasText: new RegExp(`^${title}$`, "i") }),
    })
    .first();
}

async function boxHeight(page: Page, title: string): Promise<number> {
  const box = await panelRoot(page, title).boundingBox();
  if (!box) throw new Error(`No bounding box for panel "${title}"`);
  return box.height;
}

test.describe("Platform P&L footer chips", () => {
  // Inject a minted admin session cookie (read-only admin-DB lookup) so
  // middleware lets the dev-only fixture route render instead of bouncing
  // to /login. Mirrors the rest of the responsive harness.
  test.beforeEach(async ({ context, baseURL }) => {
    const { cookieValue } = await mintAdminSession();
    const url = new URL(baseURL ?? "http://localhost:3000");
    await context.addCookies([
      {
        name: SESSION_COOKIE_NAME,
        value: cookieValue,
        domain: url.hostname,
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
  });

  test("desktop 1280: chips render, P&L box not taller than siblings", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.goto(FIXTURE, { waitUntil: "networkidle" });

    const pnl = panelRoot(page, "Platform P&L");
    await expect(pnl).toBeVisible();

    // Chips present at the bottom of the P&L box.
    const chip24h = pnl.getByText(/^24h$/);
    const chip7d = pnl.getByText(/^7d$/);
    await expect(chip24h).toBeVisible();
    await expect(chip7d).toBeVisible();

    // Heights: equal-height grid → P&L must NOT exceed its siblings.
    const hBal = await boxHeight(page, "Balances");
    const hPnl = await boxHeight(page, "Platform P&L");
    const hAct = await boxHeight(page, "Activity");
    // eslint-disable-next-line no-console
    console.log(
      `[pnl-footer] desktop heights — Balances=${hBal} PnL=${hPnl} Activity=${hAct}`,
    );
    const tallest = Math.max(hBal, hAct);
    // 1px tolerance for sub-pixel rounding.
    expect(hPnl).toBeLessThanOrEqual(tallest + 1);

    // Chip footer sits in the lower portion of the box (pinned bottom).
    const pnlBox = await pnl.boundingBox();
    const chipBox = await chip24h.boundingBox();
    if (!pnlBox || !chipBox)
      throw new Error("missing bounding box for pinned-chip check");
    const chipCenterY = chipBox.y + chipBox.height / 2;
    const panelMidY = pnlBox.y + pnlBox.height / 2;
    expect(chipCenterY).toBeGreaterThan(panelMidY);

    await pnl.screenshot({
      path: "audit-artifacts/pnl-footer-chips-desktop.png",
    });
  });

  test("mobile 390: three panels stack vertically", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 1400 });
    await page.goto(FIXTURE, { waitUntil: "networkidle" });

    const bal = await panelRoot(page, "Balances").boundingBox();
    const pnl = await panelRoot(page, "Platform P&L").boundingBox();
    const act = await panelRoot(page, "Activity").boundingBox();
    if (!bal || !pnl || !act) throw new Error("missing panel bounding boxes");

    // Chips still render on mobile.
    await expect(
      panelRoot(page, "Platform P&L").getByText(/^24h$/),
    ).toBeVisible();
    await expect(
      panelRoot(page, "Platform P&L").getByText(/^7d$/),
    ).toBeVisible();

    // Stacked: each panel starts below the previous one's top.
    expect(pnl.y).toBeGreaterThan(bal.y);
    expect(act.y).toBeGreaterThan(pnl.y);
  });
});
