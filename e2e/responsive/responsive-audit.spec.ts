import { test, expect } from "@playwright/test";
import { mintAdminSession, readSampleUserId } from "./mint-session";
import {
  injectSessionCookie,
  seedCollapsedRail,
  assertAuthenticated,
  auditRouteOnPage,
  summarizeResult,
  writeReport,
  type RouteViewportResult,
} from "./runner";
import {
  VIEWPORTS,
  PRIORITY_VIEWPORTS,
  WAVE0_ROUTES,
  viewportLabel,
} from "./config";

/**
 * Wave 0 — the reusable rendered responsive harness + its acceptance gate.
 *
 * Two modes, switched by the RESPONSIVE_EXPECT_CLEAN env var:
 *
 *   (default, BEFORE the fix) — ACCEPTANCE GATE: the harness MUST report at
 *   least one GATING offender (horizontal overflow and/or in-flow sibling
 *   overlap) on /users/[id] at narrow widths. This proves the detector
 *   actually catches the known rendered break (the anti-class-reading
 *   safeguard). If it finds zero, the detector is wrong and this test
 *   FAILS loudly — we do not fake the gate.
 *
 *   (RESPONSIVE_EXPECT_CLEAN=1, AFTER the fix) — asserts the SAME route has
 *   ZERO gating offenders across every viewport. Green here = measured
 *   clean, not assumed.
 *
 * The same spec file serves both runs so the before/after comparison is
 * apples-to-apples (identical detector, identical viewport matrix).
 */

const EXPECT_CLEAN = process.env.RESPONSIVE_EXPECT_CLEAN === "1";

test.describe("responsive audit — Wave 0 (/users/[id])", () => {
  test("detect (or verify-clean) gating offenders across the viewport matrix", async ({
    browser,
    baseURL,
  }) => {
    expect(baseURL, "baseURL must be set").toBeTruthy();

    // 1. Mint the admin_session cookie (read-only admin read + jose sign).
    const { cookieValue, admin } = await mintAdminSession();
    console.log(
      `[responsive] minted admin_session for ${admin.username} (${admin.role})`,
    );

    // 2. Pick a real entity id (read-only) for any route that needs one.
    // Wave 0 audits the self-contained fixture route, so a missing id is
    // non-fatal here; later waves' real detail routes rely on it.
    const sampleUserId = await readSampleUserId();
    if (!sampleUserId) {
      console.warn(
        "[responsive] no user row found — routes needing a sample id will be skipped",
      );
    }

    const context = await browser.newContext();
    await injectSessionCookie(context, cookieValue, baseURL!);
    // Collapse the persistent right-edge docked panels so we measure PAGE
    // CONTENT layout, not the fixed-overlay chrome (which blankets a phone
    // viewport and would mask the hero). See seedCollapsedRail.
    await seedCollapsedRail(context);
    const page = await context.newPage();

    try {
      // 3. Fail loud if the minted cookie doesn't satisfy middleware.
      await assertAuthenticated(page);
      console.log("[responsive] auth sanity OK — /dashboard did not bounce to /login");

      const allResults: RouteViewportResult[] = [];

      for (const route of WAVE0_ROUTES) {
        if (route.needsSampleUser && !sampleUserId) {
          console.warn(`[responsive] skipping ${route.key} — no sample id`);
          continue;
        }
        const resolvedPath = route.needsSampleUser
          ? route.path.replace(":sampleUserId", sampleUserId!)
          : route.path;
        const viewports = route.priority
          ? [...VIEWPORTS, ...PRIORITY_VIEWPORTS].sort(
              (a, b) => a.width - b.width,
            )
          : VIEWPORTS;

        const routeResults = await auditRouteOnPage(
          page,
          route,
          resolvedPath,
          viewports,
        );
        for (const r of routeResults) console.log(`[responsive] ${summarizeResult(r)}`);
        allResults.push(...routeResults);
      }

      const reportName = EXPECT_CLEAN
        ? "wave0-after.json"
        : "wave0-before.json";
      const reportPath = writeReport(reportName, allResults);
      console.log(`[responsive] wrote report → ${reportPath}`);

      // Aggregate gating offenders across all route×viewport results.
      const gatingResults = allResults.filter(
        (r) => r.result.gatingCount > 0,
      );
      const totalGating = allResults.reduce(
        (n, r) => n + r.result.gatingCount,
        0,
      );

      // Detailed log of the gating offenders for the record.
      for (const r of gatingResults) {
        for (const o of r.result.offenders.filter(
          (x) => x.severity === "gating",
        )) {
          const other = o.other
            ? ` ⨯ ${o.other.selector} "${o.other.text}"`
            : "";
          console.log(
            `[responsive]   GATING ${o.kind} @ ${viewportLabel(r.viewport)}: ` +
              `${o.selector} "${o.text}"${other} — ${o.detail}`,
          );
        }
      }

      if (EXPECT_CLEAN) {
        // AFTER the fix — must be clean everywhere.
        expect(
          totalGating,
          `Expected ZERO gating offenders after the fix, but found ${totalGating} ` +
            `across ${gatingResults.length} viewport(s). See ${reportPath} + ` +
            `audit-artifacts/*.png (red boxes mark the offenders).`,
        ).toBe(0);
        console.log(
          "[responsive] CLEAN — zero gating offenders across the matrix.",
        );
      } else {
        // BEFORE the fix — the detector MUST reproduce the known break.
        expect(
          totalGating,
          `ACCEPTANCE GATE FAILED: the harness found ZERO gating offenders on ` +
            `/users/[id]. The known KPI-over-helper-text overlap was not ` +
            `detected — the detector is wrong and must be iterated until it ` +
            `catches the rendered break. (Did NOT fake the gate.)`,
        ).toBeGreaterThan(0);
        console.log(
          `[responsive] ACCEPTANCE GATE PASSED — reproduced ${totalGating} ` +
            `gating offender(s) on /users/[id] before any fix.`,
        );
      }
    } finally {
      await context.close();
    }
  });
});
