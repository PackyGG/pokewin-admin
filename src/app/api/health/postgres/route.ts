import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";

import { getProdReadDrizzleDb } from "@/lib/db";
import { constantTimeEqual } from "@/lib/security/constant-time";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

type ReplicationHealthRow = {
  enabled_subscriptions: number;
  running_subscriptions: number;
  not_ready_tables: number;
  last_message_at: Date | string | null;
  apply_error_count: string;
  sync_error_count: string;
};

const MAX_REPLICATION_MESSAGE_AGE_MS = 120_000;

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
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const startedAt = Date.now();
  try {
    const db = getProdReadDrizzleDb();
    const result = await db.execute<ReplicationHealthRow>(sql`
      WITH enabled_subscriptions AS (
        SELECT oid, subname
        FROM pg_subscription
        WHERE subenabled
      ),
      subscription_status AS (
        SELECT
          enabled.oid,
          status.pid,
          status.last_msg_receipt_time
        FROM enabled_subscriptions enabled
        LEFT JOIN pg_stat_subscription status
          ON status.subid = enabled.oid
         AND status.relid IS NULL
      ),
      table_status AS (
        SELECT COUNT(*) FILTER (WHERE srsubstate <> 'r')::int AS not_ready_tables
        FROM pg_subscription_rel
      ),
      error_stats AS (
        SELECT
          COALESCE(SUM(apply_error_count), 0)::text AS apply_error_count,
          COALESCE(SUM(sync_error_count), 0)::text AS sync_error_count
        FROM pg_stat_subscription_stats
      )
      SELECT
        COUNT(*)::int AS enabled_subscriptions,
        COUNT(*) FILTER (WHERE status.pid IS NOT NULL)::int
          AS running_subscriptions,
        table_status.not_ready_tables,
        MAX(status.last_msg_receipt_time) AS last_message_at,
        error_stats.apply_error_count,
        error_stats.sync_error_count
      FROM subscription_status status
      CROSS JOIN table_status
      CROSS JOIN error_stats
      GROUP BY
        table_status.not_ready_tables,
        error_stats.apply_error_count,
        error_stats.sync_error_count
    `);
    const replication = result.rows[0];
    const lastMessageAt = replication?.last_message_at
      ? new Date(replication.last_message_at)
      : null;
    const lastMessageAgeMs = lastMessageAt
      ? Date.now() - lastMessageAt.getTime()
      : null;
    const replicationHealthy =
      replication != null &&
      replication.enabled_subscriptions > 0 &&
      replication.running_subscriptions ===
        replication.enabled_subscriptions &&
      replication.not_ready_tables === 0 &&
      lastMessageAgeMs != null &&
      lastMessageAgeMs >= 0 &&
      lastMessageAgeMs <= MAX_REPLICATION_MESSAGE_AGE_MS;

    if (!replicationHealthy) {
      return NextResponse.json(
        {
          ok: false,
          reachable: true,
          replicationHealthy: false,
          latencyMs: Date.now() - startedAt,
          serving: "postgres",
          replication: {
            enabledSubscriptions:
              replication?.enabled_subscriptions ?? 0,
            runningSubscriptions:
              replication?.running_subscriptions ?? 0,
            notReadyTables: replication?.not_ready_tables ?? 0,
            lastMessageAt: lastMessageAt?.toISOString() ?? null,
            lastMessageAgeMs,
            applyErrorCount: replication?.apply_error_count ?? "0",
            syncErrorCount: replication?.sync_error_count ?? "0",
          },
        },
        { status: 503 },
      );
    }

    return NextResponse.json({
      ok: true,
      reachable: true,
      replicationHealthy: true,
      latencyMs: Date.now() - startedAt,
      serving: "postgres",
      replication: {
        enabledSubscriptions: replication.enabled_subscriptions,
        runningSubscriptions: replication.running_subscriptions,
        notReadyTables: replication.not_ready_tables,
        lastMessageAt: lastMessageAt?.toISOString() ?? null,
        lastMessageAgeMs,
        applyErrorCount: replication.apply_error_count,
        syncErrorCount: replication.sync_error_count,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        reachable: false,
        latencyMs: Date.now() - startedAt,
        serving: "postgres",
        error: error instanceof Error ? error.name : "DatabaseError",
      },
      { status: 503 },
    );
  }
}
