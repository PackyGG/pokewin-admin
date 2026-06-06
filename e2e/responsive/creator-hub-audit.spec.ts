import { test, expect } from "@playwright/test";
import {
  mintCreatorHubSession,
  readSampleCreatorId,
} from "./mint-session";
import {
  injectSessionCookie,
  seedCollapsedRail,
  assertCreatorHubAuthenticated,
  auditRouteOnPage,
  summarizeResult,
  writeReport,
  type RouteViewportResult,
} from "./runner";
import {
  VIEWPORTS,
  PRIORITY_VIEWPORTS,
  CREATOR_HUB_ROUTES,
  type AuditRoute,
} from "./config";

const EXPECT_CLEAN = process.env.RESPONSIVE_EXPECT_CLEAN === "1";

function resolveRoutePath(
  route: AuditRoute,
  sampleCreatorId: string | null,
): string | null {
  if (route.needsSampleCreator && !sampleCreatorId) return null;
  if (route.needsSampleCreator) {
    return route.path.replace(":sampleCreatorId", sampleCreatorId!);
  }
  return route.path;
}

test.describe("responsive audit — Creator Hub", () => {
  test("hub routes across the viewport matrix", async ({ browser, baseURL }) => {
    test.setTimeout(600_000);
    expect(baseURL, "baseURL must be set").toBeTruthy();

    const { cookieValue, admin } = await mintCreatorHubSession();
    console.log(
      `[responsive:hub] minted admin_session for ${admin.username} (${admin.role})`,
    );

    const sampleCreatorId = await readSampleCreatorId();
    if (!sampleCreatorId) {
      console.warn(
        "[responsive:hub] no creator user in MAIN DB — detail routes skipped",
      );
    }

    const context = await browser.newContext();
    await injectSessionCookie(context, cookieValue, baseURL!);
    await seedCollapsedRail(context);
    const page = await context.newPage();

    try {
      await assertCreatorHubAuthenticated(page);

      const allResults: RouteViewportResult[] = [];

      for (const route of CREATOR_HUB_ROUTES) {
        const resolvedPath = resolveRoutePath(route, sampleCreatorId);
        if (!resolvedPath) continue;

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
        for (const r of routeResults) {
          console.log(`[responsive:hub] ${summarizeResult(r)}`);
        }
        allResults.push(...routeResults);
      }

      const reportPath = writeReport(
        EXPECT_CLEAN ? "creator-hub-after.json" : "creator-hub-before.json",
        allResults,
      );

      const totalGating = allResults.reduce(
        (n, r) => n + r.result.gatingCount,
        0,
      );

      if (EXPECT_CLEAN) {
        expect(
          totalGating,
          `Expected ZERO gating offenders on Creator Hub routes, found ${totalGating}. See ${reportPath}.`,
        ).toBe(0);
      }
    } finally {
      await context.close();
    }
  });
});
