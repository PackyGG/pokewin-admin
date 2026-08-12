import { NextResponse } from "next/server";

import { sql } from "drizzle-orm";
import { getProdReadDrizzleDb } from "@/lib/db";
import { constantTimeEqual } from "@/lib/security/constant-time";
import { getScopedDashboardTrendSeries } from "@/lib/queries/dashboard-trend-series";
import { getRealizedPnlSnapshot } from "@/lib/queries/_realized-pnl";
import { getRewardCostsToday } from "@/lib/queries/dashboard-reward-costs-today";
import { getCreatorCostsToday } from "@/lib/queries/dashboard-creator-costs-today";
import { getUpgraderStats } from "@/lib/queries/dashboard-upgrader";
import { getDailyPnl } from "@/lib/queries/pnl";
import { getCountryRestrictions } from "@/lib/queries/geo-blocking";
import { getFiatConfig } from "@/lib/queries/fiat";
import { buildKpiWindowPayload } from "@/app/(admin)/dashboard/kpi-window-data";
import { runSentryCronMonitor } from "@/lib/sentry-cron";

/**
 * PostgreSQL/cache keep-warm cron. A bare `SELECT 1` leaves the
 * `unstable_cache` entries cold: after a
 * 60s/300s cache expiry a burst of concurrent admin loads re-runs the heavy
 * Postgres aggregates all at once and stampedes the mirror pool. So we also
 * CALL the same cached entry-point functions the pages call — populating the
 * SAME cache keys — so the next real request reads warm.
 *
 * These calls only WARM the cache; they never edit those functions'
 * internals (several are frozen money-math).
 *
 * Everything here is read-only and never logs secrets. One slow/failing
 * refresh never fails the cron.
 *
 * Secured with Vercel's cron secret: when CRON_SECRET is set, Vercel sends
 * `Authorization: Bearer <CRON_SECRET>` on the scheduled invocation; we
 * reject anything else. When it is not set (e.g. local dev) the route stays
 * callable so it can't silently break.
 *
 * ─── Why the warmers are split into two lanes ────────────────────────────
 *
 * Mirror reads are admitted by a process-wide semaphore sized to the mirror
 * pool (`withReadAdmissionControl` in `src/lib/db.ts`). That cap is SHARED
 * with live page renders, so what this cron must bound is not how many
 * WARMERS it runs but how many mirror reads they demand at once.
 *
 * A flat pool of two workers did not bound that: every heavy warmer fans out
 * internally (the KPI snapshot drives `dashboardStatsInner`'s 11-query batch,
 * the trend snapshot six legs plus two table probes), so two heavy warmers
 * side by side could occupy every permit for the whole invocation and an
 * admin loading /dashboard at the same moment queued behind all of it — which
 * is exactly how a leg overruns its 15s `safeQuery` budget and the tile
 * renders "Couldn't load this section".
 *
 * So warmers are classified by their internal fan-out and run in two serial
 * lanes:
 *   • HEAVY — multi-leg aggregates. Strictly one at a time, so the cron's
 *     peak demand is ONE aggregate's fan-out (each already self-capped at 2
 *     by its own `runWithConcurrency`), not an unbounded product of two.
 *   • LIGHT — single-statement / config reads. They cost one round trip each,
 *     so running this lane alongside the heavy one adds a predictable +1.
 *
 * Peak mirror demand from this route is therefore bounded and predictable:
 * one heavy fan-out plus one single read, leaving headroom on the shared
 * limiter for live page loads instead of monopolising it.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Trend-chart window the dashboard actually renders — mirrors
 * `DASHBOARD_CHART_PERIOD` in `src/app/(admin)/dashboard/page.tsx`. The
 * scoped loader below resolves the same env + blacklist scope the page does,
 * so it fills the SAME `dashboard-trends-*` cache key the page reads.
 */
const DASHBOARD_CHART_PERIOD = "30d" as const;

/**
 * Stop STARTING new warmers once this much of the invocation is gone.
 *
 * `maxDuration` is a hard platform kill: a run cut off mid-warmer leaves a
 * frozen isolate still holding mirror sessions and permits (only the
 * `READ_PERMIT_WATCHDOG_MS` backstop reclaims those). Returning cleanly and
 * letting the next five-minute invocation continue is strictly cheaper — the
 * cross-request caches these warmers fill are shared, so warming resumes
 * where it stopped rather than restarting.
 */
const WARM_START_DEADLINE_MS = 40_000;

type Warmer = readonly [label: string, run: () => Promise<unknown>];

/**
 * Multi-leg aggregates — run ONE at a time.
 *
 * Ordered by how visibly a cold entry fails for an operator: the two
 * dashboard readers whose degraded states are the reported "Couldn't load
 * this section" / "Live data is temporarily unavailable" tiles come first,
 * then the slower today/lifetime tiles.
 *
 * Every entry must be a cache some rendered page actually reads. Two former
 * entries were not, and each ran its full fan-out every five minutes for a
 * key nobody consumed:
 *   • `getDashboardStats("30d")` — /dashboard moved its charts to
 *     `getScopedDashboardTrendSeries` and its KPIs to `buildKpiWindowPayload`,
 *     leaving this cron as its only caller. Its one useful side effect was
 *     filling the trend snapshot (its `trendSeries` leg calls
 *     `getDashboardTrendSeries` with the same period + scope, hence the same
 *     cache key), which the dedicated warmer below now does directly — without
 *     the eleven-query batch wrapped around it.
 *   • `getCostBreakdownLifetimeCached` / `getInsightsHubWager` — the /insights
 *     hub page and the topbar money pills they were written for no longer
 *     exist. /analytics reads `getCostBreakdownCached`, a DIFFERENT
 *     `unstable_cache` key (per-period, contributor limit 10), so the lifetime
 *     assembly (~45 ledger scans) warmed nothing a page reads.
 * `scripts/__fixtures__/perf-api-cron.test.ts` pins that relationship in both
 * directions, so re-adding a consumer for either reader fails the gate until
 * its warmer comes back.
 */
const HEAVY_WARMERS: readonly Warmer[] = [
  // Warms the Redis KPI SNAPSHOT the strip actually reads, not just the
  // aggregate underneath it. Without this the snapshot was only ever written
  // by a real page load, so the first admin after a soft expiry paid the whole
  // cold assembly and the tiles blanked when it overran.
  //
  // This ALSO warms `getDashboardKpiStats("today")` and every cache under it
  // (`computeKpiWindowPayload` awaits it as its first leg), so warming that
  // aggregate separately — as this list used to — was a duplicate run of the
  // same 11-query batch for zero additional cache coverage.
  ["dashboardKpiSnapshotToday", () => buildKpiWindowPayload("today")],
  // The six-leg trend snapshot behind the /dashboard Trends grid. This is the
  // reader whose degraded path renders "Live data is temporarily unavailable"
  // per chart, and it is the ONLY dashboard chart source since the page moved
  // off `getDashboardStats`.
  [
    "dashboardTrendSeries",
    () => getScopedDashboardTrendSeries(DASHBOARD_CHART_PERIOD),
  ],
  ["rewardCostsToday", () => getRewardCostsToday()],
  ["creatorCostsToday", () => getCreatorCostsToday()],
  ["dailyPnl", () => getDailyPnl()],
  ["realizedPnl", () => getRealizedPnlSnapshot()],
] as const;

/**
 * Single-statement reads — cheap enough to run alongside the heavy lane.
 *
 * `getTotalUserCount` used to sit here. It fills `cachedUserCounts` under the
 * exact same key `dashboardStatsInner` computes (same blacklist fragment, same
 * UTC day/week/month boundaries), so the KPI-snapshot warmer above already
 * covers it — and it has no other caller. Warming it separately was a second
 * concurrent COUNT scan of `"user"` for a cache entry that was about to be
 * filled anyway.
 */
const LIGHT_WARMERS: readonly Warmer[] = [
  ["geoBlockingRestrictions", () => getCountryRestrictions()],
  ["fiatConfig", () => getFiatConfig()],
  ["upgraderStats", () => getUpgraderStats()],
] as const;

/**
 * Run one lane strictly in sequence, recording every outcome. Never rejects:
 * a warmer that throws is recorded and the lane continues, and a warmer that
 * would start after the deadline is recorded as skipped rather than launched.
 */
async function runWarmLane(
  lane: readonly Warmer[],
  warmed: Record<string, string>,
  deadline: number,
): Promise<void> {
  for (const [label, run] of lane) {
    if (Date.now() >= deadline) {
      warmed[label] = "skipped: time budget exhausted";
      continue;
    }
    const startedAt = Date.now();
    try {
      await run();
      warmed[label] = `ok ${Date.now() - startedAt}ms`;
    } catch (reason) {
      warmed[label] = `err: ${
        reason instanceof Error ? reason.message : String(reason)
      }`;
    }
  }
}

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET?.trim();
  if (secret) {
    const auth = request.headers.get("authorization");
    // Constant-time: a plain `!==` short-circuits on the first wrong byte,
    // leaking the secret through response timing on a world-reachable route.
    if (!constantTimeEqual(auth, `Bearer ${secret}`)) {
      return new NextResponse("Unauthorized", { status: 401 });
    }
  } else if (process.env.NODE_ENV === "production") {
    // SECURITY (SECURITY_AUDIT.md LOW): fail CLOSED in production when the
    // secret is unset, instead of leaving these heavy prod-DB warmers
    // world-callable. Local dev stays open. Vercel sends this bearer for
    // scheduled crons when CRON_SECRET is configured.
    return new NextResponse("Unauthorized", { status: 401 });
  }

  return runSentryCronMonitor(
    { slug: "/api/cron/warm", schedule: "*/5 * * * *" },
    async () => {
      // Postgres keep-warm — read-only ping against the prod game DB.
      // This is also the route's load-shedding gate: if the mirror cannot accept
      // one cheap query, do not launch the aggregate warmers into the same
      // constrained role. The next five-minute invocation retries naturally.
      let postgres: string;
      const startedAt = Date.now();
      try {
        const db = getProdReadDrizzleDb();
        await db.execute(sql`SELECT 1`);
        postgres = `ok ${Date.now() - startedAt}ms`;
      } catch (err) {
        console.warn(
          "[cron.warm] PostgreSQL unavailable; skipping cache warmers",
          {
            error: err instanceof Error ? err.message : String(err),
          },
        );
        return NextResponse.json(
          { ok: false, postgres: "unavailable", warmed: {} },
          { status: 503 },
        );
      }

      // Heavy-cache keep-warm — refresh the hottest shared aggregates so a burst
      // of concurrent admin loads after a cache expiry reads warm cache instead of
      // re-stampeding the mirror pool. All read-only; the two lanes bound how much
      // of the shared read-admission budget this cron can hold at once (see the
      // module doc), and one slow/failing refresh never fails the cron.
      const warmed: Record<string, string> = {};
      const deadline = startedAt + WARM_START_DEADLINE_MS;
      try {
        await Promise.all([
          runWarmLane(HEAVY_WARMERS, warmed, deadline),
          runWarmLane(LIGHT_WARMERS, warmed, deadline),
        ]);
      } catch (err) {
        // Defensive: `runWarmLane` swallows its own failures, but never let
        // warming fail the cron.
        warmed.error = err instanceof Error ? err.message : String(err);
      }

      return NextResponse.json({ ok: true, postgres, warmed });
    },
  );
}
