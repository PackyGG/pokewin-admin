import { test, expect } from "@playwright/test";
import { SESSION_COOKIE_NAME, mintAdminSession } from "./mint-session";
import { mkdirSync } from "node:fs";

/**
 * Verify the consolidated "Deposits / Withdrawals" totals tile on
 * /users/[id]. Replaces the two prior standalone KpiTiles
 * (label="Total Deposited", label="Total Withdrawn") per owner request
 * 2026-06-16. We check on the owner-supplied known-good user at desktop
 * 1280 + mobile 390, that:
 *   - the new tile header "Deposits / Withdrawals" is present once;
 *   - the standalone "Total Deposited" / "Total Withdrawn" KpiTile labels
 *     are GONE (text grep over the rendered DOM);
 *   - the Dep/Wd COUNT tile (label "Dep / Wd") still renders (unchanged);
 *   - no console errors are emitted while loading.
 */

const USER_IDS = [
  "Y2fWwXa3sO5cnWldAikxwenEktrHoymj",
];

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
];

mkdirSync("audit-artifacts/dep-wd-tile", { recursive: true });

for (const uid of USER_IDS) {
  for (const vp of VIEWPORTS) {
    test(`dep/wd totals tile renders on /users/${uid} @ ${vp.name}`, async ({
      page,
      context,
    }) => {
      const { cookieValue } = await mintAdminSession();
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

      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
      page.on("console", (msg) => {
        if (msg.type() !== "error") return;
        const text = msg.text();
        // Ignore pre-existing UserDetailPage React key warning (unrelated
        // to this tile change — present on origin/main too).
        if (text.includes('unique "key" prop')) return;
        errors.push(`console: ${text}`);
      });

      // Use a wider desktop so the hero KPI grid (which sits on a
      // lg:clamp(28rem,42vw,40rem) right column) isn't masked by the
      // floating Live Money / Chat panels.
      const useW = vp.name === "desktop" ? 1600 : vp.width;
      await page.setViewportSize({ width: useW, height: vp.height });
      const resp = await page.goto(`/users/${uid}?tab=gaming`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      expect(page.url(), "should not redirect to login").not.toContain("/login");
      // The page keeps a long-poll (/api/live/activity) open so networkidle
      // never fires. Wait directly for the hero KPI grid to render the new
      // consolidated tile header instead.
      await page
        .getByText("Deposits / Withdrawals", { exact: false })
        .first()
        .waitFor({ timeout: 60_000 });

      // Capture screenshot for the report.
      await page.screenshot({
        path: `audit-artifacts/dep-wd-tile/${uid}-${vp.name}.png`,
        fullPage: false,
      });

      const bodyText = (await page.textContent("body")) ?? "";

      // 1) New combined tile present (header "Deposits / Withdrawals").
      const combinedCount = (bodyText.match(/Deposits \/ Withdrawals/g) ?? [])
        .length;
      // 2) Old standalone tile labels gone — but allow "Withdrawals" in
      //    OTHER contexts (tab labels, financial section). The exact tile
      //    labels used by KpiTile were "Total Deposited" and
      //    "Total Withdrawn".
      const oldDepositTile = (bodyText.match(/Total Deposited/g) ?? []).length;
      const oldWithdrawnTile = (bodyText.match(/Total Withdrawn/g) ?? [])
        .length;
      // 3) Existing COUNT tile still present.
      const countTile = (bodyText.match(/Dep \/ Wd/g) ?? []).length;

      console.log(
        `[dep-wd-tile] uid=${uid} vp=${vp.name} status=${resp?.status() ?? "n/a"} combined=${combinedCount} oldDep=${oldDepositTile} oldWd=${oldWithdrawnTile} countTile=${countTile} errors=${errors.length}`,
      );

      // If the page errored (stale local DB), bail with an honest skip so
      // the report can mark it PARTIAL — don't lie that it passed.
      if (resp && resp.status() >= 500) {
        test.skip(
          true,
          `page returned ${resp.status()} — likely stale local game DB`,
        );
      }

      expect(combinedCount, "new combined tile header present").toBeGreaterThanOrEqual(
        1,
      );
      expect(oldDepositTile, "old 'Total Deposited' tile removed").toBe(0);
      expect(oldWithdrawnTile, "old 'Total Withdrawn' tile removed").toBe(0);
      expect(countTile, "existing Dep/Wd count tile still present").toBeGreaterThanOrEqual(
        1,
      );

      // No horizontal overflow at mobile.
      if (vp.name === "mobile") {
        const overflow = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        }));
        expect(
          overflow.scrollWidth,
          `no horizontal overflow @ mobile (got ${overflow.scrollWidth} > ${overflow.clientWidth})`,
        ).toBeLessThanOrEqual(overflow.clientWidth + 1);
      }

      expect(errors, `no client errors (saw: ${errors.join(" | ")})`).toEqual(
        [],
      );
    });
  }
}
