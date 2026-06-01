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
 * Upgrader profitability — total wager / payout / pnl, plus a
 * per-target-multiplier-bucket breakdown.
 *
 * Upgrader has no borrow concept (verified — no `borrow_percentage`
 * field on `upgrader_games`, no convention to read from the metadata
 * blob beyond pack-opening rows). Every upgrader game in the period
 * counts on both wager and payout sides.
 *
 * Creator-on-stream rows are still excluded — same session_windows
 * CTE. The session_windows uses upgrader_games.created_at as the
 * row timestamp.
 *
 * Target-multiplier buckets group plays into the obvious clean
 * ranges (matches /transactions/upgrader's chart and the user's
 * mental model). Bucket assignment runs SQL-side so the result set
 * is small (~10 rows). The bucket key is read from the linked
 * provably_fair_results.result_metadata blob via the same parsing
 * convention as the rest of the codebase (see
 * `parseUpgraderMetadata`). Falls back to "unknown" if the metadata
 * doesn't carry a target value.
 */

const TARGET_BUCKETS = [
  { label: "<2×", min: 0, max: 2 },
  { label: "2–5×", min: 2, max: 5 },
  { label: "5–10×", min: 5, max: 10 },
  { label: "10–25×", min: 10, max: 25 },
  { label: "25–100×", min: 25, max: 100 },
  { label: "100×+", min: 100, max: null },
] as const;

export type UpgraderBucketRow = {
  label: string;
  bets: number;
  totalWager: number;
  totalPayout: number;
  pnl: number;
  marginPct: number;
  hitRatePct: number;
  rtpPct: number;
};

export type UpgraderProfitabilityData = {
  period: GamesPeriod;
  totals: {
    bets: number;
    wins: number;
    losses: number;
    hitRatePct: number;
    wager: number;
    payouts: number;
    pnl: number;
    marginPct: number;
    rtpPct: number;
    avgBet: number;
  };
  buckets: UpgraderBucketRow[];
  /**
   * Cohort labels for the histogram + drilldown wiring. Stable keys
   * shared with the drilldown action's `parseBucket` so a chart click
   * resolves to the right bucket query.
   */
  cohorts: {
    label: string;
    /** Range description ("Low rollers", "Mid rollers", etc.) */
    cohort: "Low rollers" | "Mid rollers" | "Risk takers" | "Whales" | "Other";
  }[];
};

export async function getUpgraderProfitability(
  period: GamesPeriod,
): Promise<UpgraderProfitabilityData> {
  return withTiming("insights-games.upgrader", async () => {
    const db = await getDb();
    const scope = await realCustomersScopeSql();
    const sessionWindowsCte = await getCreatorSessionWindowsCte();
    const hours = hoursForPeriod(period);

    const ugCutoff =
      hours !== null
        ? `AND ug.created_at >= NOW() - INTERVAL '${hours} hours'`
        : "";

    // Read target multiplier off the linked PF result's metadata.
    // The blob shape isn't pinned by the backend, so we try the
    // canonical key plus the most common variants (mirrors
    // `parseUpgraderMetadata`'s MULTIPLIER_KEYS list). Each key is
    // tried in order via COALESCE; the first numeric value wins.
    // Anything left as NULL maps to the "unknown" bucket below.
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
      target_multiplier: string | null;
      bets: string;
      wins: string;
      wager: string;
      payouts: string;
    };

    // Join chain: upgrader_games.id == game_sessions.game_id when
    // game_type='upgrader' (canonical link verified in
    // users-transactions.ts). From there PF result is one-to-one
    // via game_session_id. LEFT JOINs so games without a PF row
    // still count — they land in the "Unknown" bucket downstream.
    const rows = await db.$queryRawUnsafe<Row[]>(
      `WITH ${sessionWindowsCte},
            ug_in_scope AS (
         SELECT ug.id,
                ug.bet_amount::numeric AS bet_amount,
                ug.won_amount::numeric AS won_amount,
                ${targetExpr} AS target_multiplier
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
           ${ugCutoff}
       )
       SELECT target_multiplier::text AS target_multiplier,
              COUNT(*)::text AS bets,
              COUNT(*) FILTER (WHERE won_amount > 0)::text AS wins,
              COALESCE(SUM(bet_amount), 0)::text AS wager,
              COALESCE(SUM(won_amount), 0)::text AS payouts
       FROM ug_in_scope
       GROUP BY target_multiplier`,
    );

    type Acc = {
      bets: number;
      wins: number;
      wager: number;
      payouts: number;
    };
    const zeroAcc = (): Acc => ({ bets: 0, wins: 0, wager: 0, payouts: 0 });
    const buckets: Record<string, Acc> = {};
    for (const b of TARGET_BUCKETS) buckets[b.label] = zeroAcc();
    // "Unknown" bucket — plays whose target couldn't be read from
    // the PF metadata. Kept separate so admins can see how much of
    // the total volume needs better tagging.
    buckets["Unknown"] = zeroAcc();

    let totalBets = 0;
    let totalWins = 0;
    let totalWager = 0;
    let totalPayout = 0;

    for (const r of rows) {
      const bets = Number(r.bets);
      const wins = Number(r.wins);
      const wager = toNumber(r.wager);
      const payouts = toNumber(r.payouts);
      totalBets += bets;
      totalWins += wins;
      totalWager += wager;
      totalPayout += payouts;
      const target =
        r.target_multiplier != null ? Number(r.target_multiplier) : null;
      let label = "Unknown";
      if (target != null && Number.isFinite(target)) {
        for (const b of TARGET_BUCKETS) {
          if (target >= b.min && (b.max == null || target < b.max)) {
            label = b.label;
            break;
          }
        }
      }
      const acc = buckets[label];
      acc.bets += bets;
      acc.wins += wins;
      acc.wager += wager;
      acc.payouts += payouts;
    }

    const bucketRows: UpgraderBucketRow[] = [...TARGET_BUCKETS, { label: "Unknown" as const }].map(
      (b) => {
        const a = buckets[b.label];
        const pnl = a.wager - a.payouts;
        const marginPct = a.wager > 0 ? (pnl / a.wager) * 100 : 0;
        const rtpPct = a.wager > 0 ? (a.payouts / a.wager) * 100 : 0;
        const hitRatePct = a.bets > 0 ? (a.wins / a.bets) * 100 : 0;
        return {
          label: b.label,
          bets: a.bets,
          totalWager: a.wager,
          totalPayout: a.payouts,
          pnl,
          marginPct,
          rtpPct,
          hitRatePct,
        };
      },
    );

    const totalPnl = totalWager - totalPayout;
    const losses = Math.max(0, totalBets - totalWins);
    // Cohort labels — group buckets into the operator-facing names
    // (low rollers / mid / risk takers / whales). The bucket label
    // stays the canonical key (drilldown action expects it), the
    // cohort name is just the display group.
    const cohortFor = (label: string): UpgraderProfitabilityData["cohorts"][number]["cohort"] => {
      if (label === "<2×" || label === "2–5×") return "Low rollers";
      if (label === "5–10×") return "Mid rollers";
      if (label === "10–25×" || label === "25–100×") return "Risk takers";
      if (label === "100×+") return "Whales";
      return "Other";
    };
    const cohorts = bucketRows.map((b) => ({
      label: b.label,
      cohort: cohortFor(b.label),
    }));

    return {
      period,
      totals: {
        bets: totalBets,
        wins: totalWins,
        losses,
        hitRatePct: totalBets > 0 ? (totalWins / totalBets) * 100 : 0,
        wager: totalWager,
        payouts: totalPayout,
        pnl: totalPnl,
        marginPct: totalWager > 0 ? (totalPnl / totalWager) * 100 : 0,
        rtpPct: totalWager > 0 ? (totalPayout / totalWager) * 100 : 0,
        avgBet: totalBets > 0 ? totalWager / totalBets : 0,
      },
      buckets: bucketRows,
      cohorts,
    };
  });
}
