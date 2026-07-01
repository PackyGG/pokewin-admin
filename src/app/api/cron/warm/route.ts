import { NextResponse } from "next/server";

import { getClickHouseClient } from "@/lib/clickhouse/client";
import { getProdDb } from "@/lib/db";
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
 * Keep-warm cron — fires a trivial `SELECT 1` at ClickHouse (and Postgres)
 * on a schedule so the ClickHouse Cloud service never idle-scales-to-zero
 * between admin visits, AND refreshes the hottest shared `unstable_cache`
 * aggregates so user requests hit warm cache instead of cold heavy scans.
 *
 * Why: measured cold-start on the first ClickHouse query after an idle gap
 * is ~422ms (service wake + TLS) vs ~30-90ms warm. The dashboard's graphs /
 * trend series + GGR are ClickHouse-served, so that cold hit is the bulk of
 * the "boxes take a few seconds" delay on a cold load. A periodic ping keeps
 * the service awake so user requests pay only the warm latency.
 *
 * But a bare `SELECT 1` leaves the `unstable_cache` entries cold: after a
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
 * Read-only + dormant-safe: ClickHouse is queried only when configured
 * (getClickHouseClient() returns null otherwise → skipped), and only a
 * `SELECT 1` ever runs against it. Every warmed function is a read-only
 * aggregate. Never writes, never logs secrets. Each warm runs under
 * `Promise.allSettled` and the whole block is wrapped so one slow/failing
 * warm never fails the cron.
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
  }

  const result = { clickhouse: "skipped" as string, postgres: "skipped" as string };

  // ClickHouse keep-warm — only when configured (dormant otherwise).
  const ch = getClickHouseClient();
  if (ch) {
    try {
      const t = Date.now();
      const rs = await ch.query({ query: "SELECT 1", format: "JSONEachRow" });
      await rs.json();
      result.clickhouse = `ok ${Date.now() - t}ms`;
    } catch (err) {
      result.clickhouse = `error: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
  }

  // Postgres keep-warm — read-only ping against the prod game DB.
  try {
    const t = Date.now();
    const db = getProdDb();
    await db.$queryRaw`SELECT 1`;
    result.postgres = `ok ${Date.now() - t}ms`;
  } catch (err) {
    result.postgres = `error: ${
      err instanceof Error ? err.message : String(err)
    }`;
  }

  // Heavy-cache keep-warm — refresh the hottest shared `unstable_cache`
  // aggregates so a burst of concurrent admin loads after a cache expiry
  // reads warm cache instead of re-stampeding the max:3 game-DB pool.
  // All read-only; each runs independently via allSettled so one slow/
  // failing warm never blocks or fails the others; the whole block is
  // wrapped so it can never throw the cron. Ordered heaviest-first (the
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
    const settled = await Promise.allSettled(
      warmers.map(async ([label, fn]) => {
        const t = Date.now();
        await fn();
        return `${label}:ok ${Date.now() - t}ms`;
      }),
    );
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
