import { getDb } from "@/lib/db";
import { getPackSetAssignmentsGrouped } from "@/lib/queries/pack-set-assignments";

/**
 * Daily opens + revenue trend for the One Piece pack pool (/one-piece).
 *
 * Pool membership is a PACK-LEVEL admin assignment (admin DB,
 * `pack_set_assignments` → `onepiece`), resolved the same way the /packs pool
 * filter does. The trend itself is read from the MAIN game DB.
 *
 * Index-or-ClickHouse (indexed Postgres path, EXPLAIN-verified against prod):
 *   - opens come from `provably_fair_results`, filtered by the won pack id in
 *     `result_metadata->>'pack_id'` + a bounded created_at range, served by
 *     `idx_pf_result_metadata_pack_id_created_at` (Bitmap Index Scan, 3
 *     searches, no Seq Scan).
 *   - revenue = opens × pack price, joined per matched pack id via
 *     `packs_pkey` (Index Scan, nested loop — never a full `packs` scan), so
 *     we avoid the ~50k-row `cards` Seq Scan a per-card payout join would
 *     trigger. `result_metadata` carries no card value, so this surface shows
 *     Opens + Revenue (both exact); lifetime payout / house edge come from the
 *     maintained `packs` columns in the KPI strip.
 *
 * The day axis is generated IN SQL (`generate_series` + `to_char`) so the
 * zero-filled buckets and the bucketed opens share the DB session's day
 * definition — no JS/DB timezone drift. Window is bounded to 30 days.
 */

const WINDOW_DAYS = 30;

export type OnePieceTrendPoint = {
  /** UTC-ish DB-local day, `YYYY-MM-DD`. */
  date: string;
  opens: number;
  revenue: number;
};

export type OnePieceTrend = {
  daily: OnePieceTrendPoint[];
  windowDays: number;
  totalOpens: number;
  totalRevenue: number;
  packCount: number;
};

export async function getOnePiecePackTrend(): Promise<OnePieceTrend> {
  const assigned = await getPackSetAssignmentsGrouped();
  const packIds = assigned.idsBySet.onepiece ?? [];

  if (packIds.length === 0) {
    return {
      daily: [],
      windowDays: WINDOW_DAYS,
      totalOpens: 0,
      totalRevenue: 0,
      packCount: 0,
    };
  }

  const db = await getDb();
  const rows = await db.$queryRawUnsafe<
    Array<{ date: string; opens: number; revenue: number }>
  >(
    `WITH days AS (
       SELECT generate_series(
         (CURRENT_DATE - INTERVAL '${WINDOW_DAYS - 1} days')::date,
         CURRENT_DATE::date,
         INTERVAL '1 day'
       )::date AS d
     ),
     opens AS (
       SELECT DATE(pf.created_at) AS d,
              (pf.result_metadata->>'pack_id')::uuid AS pack_id,
              COUNT(*)::int AS opens
       FROM provably_fair_results pf
       WHERE (pf.result_metadata->>'pack_id') = ANY($1::text[])
         AND pf.created_at >= (CURRENT_DATE - INTERVAL '${WINDOW_DAYS - 1} days')
       GROUP BY DATE(pf.created_at), (pf.result_metadata->>'pack_id')
     )
     SELECT to_char(days.d, 'YYYY-MM-DD') AS date,
            COALESCE(SUM(o.opens), 0)::int AS opens,
            COALESCE(SUM(o.opens * p.price), 0)::float8 AS revenue
     FROM days
     LEFT JOIN opens o ON o.d = days.d
     LEFT JOIN packs p ON p.id = o.pack_id
     GROUP BY days.d
     ORDER BY days.d`,
    packIds,
  );

  const daily: OnePieceTrendPoint[] = rows.map((r) => ({
    date: r.date,
    opens: Number(r.opens),
    revenue: Number(r.revenue),
  }));

  return {
    daily,
    windowDays: WINDOW_DAYS,
    totalOpens: daily.reduce((s, d) => s + d.opens, 0),
    totalRevenue: daily.reduce((s, d) => s + d.revenue, 0),
    packCount: packIds.length,
  };
}
