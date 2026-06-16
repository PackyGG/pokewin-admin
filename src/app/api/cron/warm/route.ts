import { NextResponse } from "next/server";

import { getClickHouseClient } from "@/lib/clickhouse/client";
import { getProdDb } from "@/lib/db";

/**
 * Keep-warm cron — fires a trivial `SELECT 1` at ClickHouse (and Postgres)
 * on a schedule so the ClickHouse Cloud service never idle-scales-to-zero
 * between admin visits.
 *
 * Why: measured cold-start on the first ClickHouse query after an idle gap
 * is ~422ms (service wake + TLS) vs ~30-90ms warm. The dashboard's graphs /
 * trend series + GGR are ClickHouse-served, so that cold hit is the bulk of
 * the "boxes take a few seconds" delay on a cold load. A periodic ping keeps
 * the service awake so user requests pay only the warm latency.
 *
 * Read-only + dormant-safe: ClickHouse is queried only when configured
 * (getClickHouseClient() returns null otherwise → skipped), and only a
 * `SELECT 1` ever runs. Never writes, never logs secrets.
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

  return NextResponse.json({ ok: true, ...result });
}
