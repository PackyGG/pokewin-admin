import { NextResponse } from "next/server";

import {
  getClickHouseClient,
  isClickHouseEnabled,
} from "@/lib/clickhouse/client";
import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";

/**
 * ClickHouse health + freshness probe — makes stale/fallback analytics VISIBLE
 * instead of silent. Reports, dormant-safe and read-only:
 *
 *   • reachable        — can we run a trivial query right now?
 *   • latencyMs        — round-trip of that probe query
 *   • latestEventIso / cdcLagSeconds — newest ledger_transactions.created_at
 *                        vs wall clock (the best single CDC/PeerDB lag proxy,
 *                        since ledger_transactions is the highest-volume CDC
 *                        table)
 *   • servingClickHouse — are admin analytics actually being served from
 *                         ClickHouse, or silently falling back to Postgres?
 *   • surfaces          — resolved read mode for a representative set
 *
 * Auth mirrors the keep-warm cron: when CRON_SECRET is set we require
 * `Authorization: Bearer <CRON_SECRET>` (so uptime monitors can be wired with
 * the secret); when it is unset (local dev) the route stays callable. The
 * payload contains no secrets and no user PII.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

// A small, representative slice of the cutover set across the major analytics
// areas. If these resolve to "clickhouse" the live serve path is CH; if they
// resolve to "off"/"comparison" the pages are served from Postgres.
const REPRESENTATIVE_SURFACES = [
  "dashboard_headline_ggr",
  "analytics_overview",
  "creators_analytics",
  "insights_rakeback_overview",
  "numbers",
] as const;

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET?.trim();
  if (secret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return new NextResponse("Unauthorized", { status: 401 });
    }
  }

  const configured = isClickHouseEnabled();

  // Resolve the read mode per representative surface regardless of reachability,
  // so a misconfigured cutover (CH up but surfaces still "off") is visible too.
  const surfaces: Record<string, string> = {};
  for (const key of REPRESENTATIVE_SURFACES) {
    surfaces[key] = await getAdminReadMode(key);
  }
  const servingClickHouse =
    configured &&
    REPRESENTATIVE_SURFACES.some((k) => surfaces[k] === "clickhouse");

  if (!configured || !getClickHouseClient()) {
    return NextResponse.json({
      ok: true,
      configured: false,
      reachable: false,
      dormant: true,
      servingClickHouse: false,
      serving: "postgres",
      surfaces,
      note: "ClickHouse is dormant (no CLICKHOUSE_* env) — all analytics serve from Postgres.",
    });
  }

  let reachable = false;
  let latencyMs: number | null = null;
  let probeError: string | null = null;
  try {
    const t = Date.now();
    await clickhouseRead.query({
      queryName: "health.ping",
      sql: "SELECT 1 AS ok",
      timeoutMs: 5_000,
    });
    latencyMs = Date.now() - t;
    reachable = true;
  } catch (err) {
    probeError = err instanceof Error ? err.message : String(err);
  }

  let latestEventIso: string | null = null;
  let cdcLagSeconds: number | null = null;
  if (reachable) {
    try {
      const rows = await clickhouseRead.query<{ latest_unix: number | null }>({
        queryName: "health.latest_event",
        sql: "SELECT toUnixTimestamp(max(created_at)) AS latest_unix FROM packy_prod.public_ledger_transactions FINAL WHERE _peerdb_is_deleted = 0",
        timeoutMs: 5_000,
      });
      const latestUnix = rows[0]?.latest_unix ?? null;
      if (latestUnix && latestUnix > 0) {
        latestEventIso = new Date(latestUnix * 1000).toISOString();
        cdcLagSeconds = Math.max(
          0,
          Math.round(Date.now() / 1000 - latestUnix),
        );
      }
    } catch (err) {
      probeError = err instanceof Error ? err.message : String(err);
    }
  }

  return NextResponse.json({
    ok: true,
    configured: true,
    reachable,
    dormant: false,
    latencyMs,
    latestEventIso,
    cdcLagSeconds,
    servingClickHouse,
    serving: servingClickHouse ? "clickhouse" : "postgres",
    surfaces,
    ...(probeError ? { error: probeError } : {}),
  });
}
