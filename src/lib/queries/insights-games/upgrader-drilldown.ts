import "server-only";

import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import { getCreatorSessionWindowsCte } from "../creator-session-windows";
import {
  type GamesPeriod,
  hoursForPeriod,
  realCustomersScopeSql,
} from "./_shared";

/**
 * Per-bucket drilldown for the Upgrader tab — given a target-multiplier
 * bucket key + period, returns the top 10 users in that bucket by
 * total wager. Used by the lazy expander on each bucket row.
 *
 * Buckets are the same ones the parent tab uses (TARGET_BUCKETS in
 * upgrader.ts). The PF metadata blob parse mirrors that file so the
 * grouping matches exactly.
 */

export type UpgraderBucketKey =
  | "<2×"
  | "2–5×"
  | "5–10×"
  | "10–25×"
  | "25–100×"
  | "100×+"
  | "Unknown";

export type UpgraderBucketTopUser = {
  userId: string;
  username: string | null;
  image: string | null;
  bets: number;
  wager: number;
  payout: number;
  pnl: number;
};

// Bucket → (min, max) ranges. `max = null` means "no upper bound"
// (the 100×+ bucket). null/0 ⇒ Unknown (target_multiplier was
// missing from PF metadata).
const BUCKET_RANGES: Record<
  UpgraderBucketKey,
  { min: number | null; max: number | null }
> = {
  "<2×": { min: 0, max: 2 },
  "2–5×": { min: 2, max: 5 },
  "5–10×": { min: 5, max: 10 },
  "10–25×": { min: 10, max: 25 },
  "25–100×": { min: 25, max: 100 },
  "100×+": { min: 100, max: null },
  Unknown: { min: null, max: null },
};

export async function getUpgraderBucketTopUsers(
  period: GamesPeriod,
  bucket: UpgraderBucketKey,
): Promise<UpgraderBucketTopUser[]> {
  return withTiming("insights-games.upgrader-drilldown", async () => {
    const db = await getDb();
    const scope = await realCustomersScopeSql();
    const sessionWindowsCte = await getCreatorSessionWindowsCte();
    const hours = hoursForPeriod(period);
    const ugCutoff =
      hours !== null
        ? `AND ug.created_at >= NOW() - INTERVAL '${hours} hours'`
        : "";

    const range = BUCKET_RANGES[bucket];

    // Bucket filter — SQL fragment that's TRUE for rows whose
    // target_multiplier falls inside the range. Unknown bucket = NULL
    // multiplier (PF didn't carry it).
    let bucketFilter: string;
    if (range.min === null && range.max === null) {
      bucketFilter = "tm IS NULL";
    } else if (range.max === null) {
      bucketFilter = `tm IS NOT NULL AND tm >= ${range.min}`;
    } else {
      bucketFilter = `tm IS NOT NULL AND tm >= ${range.min} AND tm < ${range.max}`;
    }

    const targetExpr = `
      COALESCE(
        NULLIF(pf.result_metadata->>'target_multiplier', '')::numeric,
        NULLIF(pf.result_metadata->>'targetMultiplier', '')::numeric,
        NULLIF(pf.result_metadata->>'multiplier', '')::numeric,
        NULLIF(pf.result_metadata->>'target_payout', '')::numeric,
        NULLIF(pf.result_metadata->>'payout_multiplier', '')::numeric,
        NULLIF(pf.result_metadata->>'cashout_multiplier', '')::numeric,
        NULLIF(pf.result_metadata->>'cashout', '')::numeric,
        NULLIF(pf.result_metadata->>'payout', '')::numeric
      )
    `;

    type Row = {
      user_id: string;
      username: string | null;
      image: string | null;
      bets: string;
      wager: string;
      payout: string;
    };

    const rows = await db.$queryRawUnsafe<Row[]>(
      `WITH ${sessionWindowsCte},
            in_bucket AS (
         SELECT ug.user_id,
                ug.bet_amount::numeric AS bet_amount,
                ug.won_amount::numeric AS won_amount
         FROM upgrader_games ug
         LEFT JOIN game_sessions gs ON gs.game_id = ug.id AND gs.game_type = 'upgrader'
         LEFT JOIN provably_fair_results pf ON pf.game_session_id = gs.id
         WHERE ug.user_id IN ${scope}
           AND NOT EXISTS (
             SELECT 1 FROM session_windows sw
             WHERE sw.uid = ug.user_id
               AND ug.created_at >= sw.win_start
               AND ug.created_at <  sw.win_end
           )
           AND (
             SELECT ${bucketFilter}
             FROM (SELECT ${targetExpr} AS tm) AS sub
           )
           ${ugCutoff}
       )
       SELECT
         ib.user_id::text AS user_id,
         u.username AS username,
         u.image AS image,
         COUNT(*)::text AS bets,
         COALESCE(SUM(ib.bet_amount), 0)::text AS wager,
         COALESCE(SUM(ib.won_amount), 0)::text AS payout
       FROM in_bucket ib
       JOIN "user" u ON u.id = ib.user_id
       GROUP BY ib.user_id, u.username, u.image
       HAVING SUM(ib.bet_amount) > 0
       ORDER BY SUM(ib.bet_amount) DESC
       LIMIT 10`,
    );

    return rows.map((r) => {
      const wager = toNumber(r.wager);
      const payout = toNumber(r.payout);
      return {
        userId: r.user_id,
        username: r.username,
        image: r.image,
        bets: Number(r.bets),
        wager,
        payout,
        pnl: wager - payout,
      };
    });
  });
}
