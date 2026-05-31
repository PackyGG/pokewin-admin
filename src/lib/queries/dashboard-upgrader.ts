import { cache } from "react";
import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { withTiming } from "@/lib/observability/query-timings";
import { blacklistNotInClause } from "./_blacklist";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";

/**
 * Upgrader Stats section on /dashboard. Lifetime-only after the perf
 * pass: the previous 9-period CASE-WHEN computation has been collapsed
 * to a single SUM/COUNT pass, and the client-side chip selector is
 * gone. Same scope rules as before — staff (admin / support), the
 * creator role itself, and the excluded-users blacklist are all
 * dropped, so the tile reads the raw customer signal only.
 *
 * SOURCE OF TRUTH — `upgrader_games`. The wager and the won value
 * both live on this table (bet_amount + won_amount per play), which
 * is the canonical record of every upgrader round and is also what
 * /transactions/upgrader renders from. Reading directly from this
 * table keeps the section's hit-rate / edge / avg-bet math self-
 * consistent without a join through ledger_transactions.
 *
 * (Upgrader plays do also flow through the ledger today as
 * upgrader_bet / upgrader_payout rows — used by the dashboard's
 * headline GGR + P&L formulas in dashboard.ts and pnl.ts. Both
 * sources agree on the volume; this section just uses the upgrader-
 * native table for the win/loss outcome flags.)
 *
 *   wager   = SUM(bet_amount)            — what players risked
 *   payouts = SUM(won_amount)            — gross value returned (0 on a loss)
 *   pnl     = wager − payouts (positive = house gained)
 *   edge    = pnl / wager * 100 (house edge %)
 *   bets    = COUNT(*) rows
 *   avgBet  = wager / bets
 *   players = COUNT(DISTINCT user_id)
 *   wins    = COUNT(*) WHERE won_amount > 0
 *   losses  = bets − wins (won_amount = 0 ⇔ lost)
 *   hitRate = wins / bets * 100
 *
 * `won_amount` is the GROSS amount credited on a win (bet × cashout
 * multiplier, persisted to 2dp) and is 0 for losing plays, so
 * wager − SUM(won_amount) is the true house margin without any
 * ledger round-trip.
 */
export type UpgraderStats = {
  wager: number;
  payouts: number;
  pnl: number;
  edge: number;
  bets: number;
  avgBet: number;
  uniquePlayers: number;
  wins: number;
  losses: number;
  hitRate: number;
};

/**
 * 5-minute cross-request cache. The Upgrader section is lifetime data
 * that drifts very slowly compared to the dashboard's wager / PnL
 * tiles, so a 5-minute floor is invisible to operators and saves the
 * full scan over `upgrader_games` on each 60s dashboard refresh.
 * The 5-minute TTL matches the realized P&L snapshot's cache.
 */
const cachedUpgraderStats = unstable_cache(
  upgraderStatsInner,
  ["dashboard-upgrader-lifetime-v2"],
  { revalidate: 300, tags: ["dashboard-lifetime"] },
);

export const getUpgraderStats = cache(async (): Promise<UpgraderStats> => {
  return withTiming("dashboard.upgrader", () => cachedUpgraderStats());
});

async function upgraderStatsInner(): Promise<UpgraderStats> {
  const db = await getDb();
  const excluded = await getExcludedUserIds();
  const blacklistIdNotIn = blacklistNotInClause("id", excluded);

  // Single lifetime scan over `upgrader_games`, narrowed to real
  // users (no staff, no creators, no blacklisted accounts). Five
  // aggregates in one pass — wager (SUM bet_amount), payouts (SUM
  // won_amount), bets (COUNT *), unique players (COUNT DISTINCT
  // user_id), wins (COUNT * WHERE won_amount > 0).
  type Row = Record<string, string>;
  const rows = await db.$queryRaw<Row[]>`
    WITH real_users AS (
      SELECT id FROM "user"
      WHERE role NOT IN ('admin', 'support', 'creator') ${Prisma.raw(blacklistIdNotIn)}
    )
    SELECT
      COALESCE(SUM(bet_amount::numeric), 0)::text AS wager,
      COALESCE(SUM(won_amount::numeric), 0)::text AS payouts,
      COUNT(*)::text AS bets,
      COUNT(DISTINCT user_id)::text AS players,
      COUNT(CASE WHEN won_amount::numeric > 0 THEN 1 END)::text AS wins
    FROM upgrader_games
    WHERE user_id IN (SELECT id FROM real_users)
  `;

  const r = rows[0] ?? {};
  const num = (key: string): number => parseFloat(r[key] ?? "0") || 0;
  const wager = num("wager");
  const payouts = num("payouts");
  const bets = num("bets");
  const uniquePlayers = num("players");
  const wins = num("wins");
  // Every game either won (won_amount > 0) or lost (won_amount = 0).
  // wins is a strict subset of bets so the subtraction is safe; clamp
  // at 0 defensively.
  const losses = Math.max(0, bets - wins);
  const pnl = wager - payouts;
  return {
    wager,
    payouts,
    pnl,
    edge: wager > 0 ? (pnl / wager) * 100 : 0,
    bets,
    avgBet: bets > 0 ? wager / bets : 0,
    uniquePlayers,
    wins,
    losses,
    hitRate: bets > 0 ? (wins / bets) * 100 : 0,
  };
}
