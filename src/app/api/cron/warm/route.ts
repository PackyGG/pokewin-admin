import { NextResponse } from "next/server";

import { sql } from "drizzle-orm";
import { getProdReadDrizzleDb } from "@/lib/db";
import { getCostBreakdownLifetimeCached } from "@/lib/queries/insights-analytics/cost-breakdown";
import { getInsightsHubWager } from "@/lib/queries/insights-analytics/hub-wager";
import {
  getDashboardKpiStats,
  getDashboardStats,
  getTotalUserCount,
} from "@/lib/queries/dashboard";
import { getRealizedPnlSnapshot } from "@/lib/queries/_realized-pnl";
import { getTodayPnl } from "@/lib/queries/dashboard-today-pnl";
import { getRewardCostsToday } from "@/lib/queries/dashboard-reward-costs-today";
import { getCreatorCostsToday } from "@/lib/queries/dashboard-creator-costs-today";
import { getUpgraderStats } from "@/lib/queries/dashboard-upgrader";
import { getDailyPnl } from "@/lib/queries/pnl";

/**
 * PostgreSQL/cache keep-warm cron. A bare `SELECT 1` leaves the
 * `unstable_cache` entries cold: after a
 * 60s/300s cache expiry a burst of concurrent admin loads re-runs the heavy
 * Postgres aggregates all at once and stampedes the small (max:3) game-DB
 * pool. So we also CALL the same cached entry-point functions the pages call
 * — populating the SAME cache keys — so the next real request reads warm.
 *
 * These calls only WARM the cache; they never edit those functions'
 * internals (several are frozen money-math). We warm the ~heaviest shared
 * stampede drivers first (cost-breakdown, hub-wager, dashboard stats + KPI
 * stats, realized-pnl) plus the cheaper today/lifetime dashboard legs.
 *
 * Everything here is read-only and never logs secrets. Aggregate refreshes
 * are concurrency-limited below the Main DB pool cap, and one slow/failing
 * refresh never fails the cron.
 *
 * Secured with Vercel's cron secret: when CRON_SECRET is set, Vercel sends
 * `Authorization: Bearer <CRON_SECRET>` on the scheduled invocation; we
 * reject anything else. When it is not set (e.g. local dev) the route stays
 * callable so it can't silently break.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET?.trim();
  if (secret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return new NextResponse("Unauthorized", { status: 401 });
    }
  } else if (process.env.NODE_ENV === "production") {
    // SECURITY (SECURITY_AUDIT.md LOW): fail CLOSED in production when the
    // secret is unset, instead of leaving these heavy prod-DB warmers
    // world-callable. Local dev stays open. Vercel sends this bearer for
    // scheduled crons when CRON_SECRET is configured.
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const result = { postgres: "skipped" as string };

  // Postgres keep-warm — read-only ping against the prod game DB.
  try {
    const t = Date.now();
    const db = getProdReadDrizzleDb();
    await db.execute(sql`SELECT 1`);
    result.postgres = `ok ${Date.now() - t}ms`;
  } catch (err) {
    result.postgres = `error: ${
      err instanceof Error ? err.message : String(err)
    }`;
  }

  // Heavy-cache keep-warm — refresh the hottest shared `unstable_cache`
  // aggregates so a burst of concurrent admin loads after a cache expiry
  // reads warm cache instead of re-stampeding the max:3 game-DB pool.
  // All read-only; each runs independently under a two-worker concurrency
  // cap so this route cannot consume all three Main DB pool slots. Ordered
  // heaviest-first (the
  // stampede drivers) to make best use of the maxDuration = 30s budget.
  const warmed: Record<string, string> = {};
  try {
    const warmers: Array<[string, () => Promise<unknown>]> = [
      ["costBreakdown", () => getCostBreakdownLifetimeCached()],
      ["hubWager", () => getInsightsHubWager()],
      ["dashboardStats30d", () => getDashboardStats("30d")],
      ["dashboardKpiToday", () => getDashboardKpiStats("today")],
      ["realizedPnl", () => getRealizedPnlSnapshot()],
      ["totalUserCount", () => getTotalUserCount()],
      ["todayPnl", () => getTodayPnl()],
      ["rewardCostsToday", () => getRewardCostsToday()],
      ["creatorCostsToday", () => getCreatorCostsToday()],
      ["upgraderStats", () => getUpgraderStats()],
      ["dailyPnl", () => getDailyPnl()],
    ];
    const settled: PromiseSettledResult<string>[] = new Array(warmers.length);
    let nextIndex = 0;
    const workers = Array.from({ length: 2 }, async () => {
      while (nextIndex < warmers.length) {
        const index = nextIndex++;
        const [label, fn] = warmers[index];
        const t = Date.now();
        try {
          await fn();
          settled[index] = {
            status: "fulfilled",
            value: `${label}:ok ${Date.now() - t}ms`,
          };
        } catch (reason) {
          settled[index] = { status: "rejected", reason };
        }
      }
    });
    await Promise.all(workers);
    settled.forEach((r, i) => {
      const label = warmers[i][0];
      warmed[label] =
        r.status === "fulfilled"
          ? r.value.slice(label.length + 1)
          : `err: ${
              r.reason instanceof Error ? r.reason.message : String(r.reason)
            }`;
    });
  } catch (err) {
    // Defensive: allSettled shouldn't reject, but never let warming fail the cron.
    warmed.error = err instanceof Error ? err.message : String(err);
  }

  return NextResponse.json({ ok: true, ...result, warmed });
}
