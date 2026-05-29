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
 * Metrics (all lifetime, all house-POV):
 *   wager         = SUM(|amount|) over upgrader_bet rows
 *   payouts       = SUM(GREATEST(|amount|, balance_delta, 0)) over
 *                   upgrader_payout rows. Different game modes ship
 *                   the won value through different fields; the
 *                   GREATEST picks whichever the backend populated.
 *   pnl           = wager − payouts (positive = house gained)
 *   edge          = pnl / wager * 100 (house edge %)
 *   bets          = COUNT(upgrader_bet rows)
 *   avgBet        = wager / bets
 *   uniquePlayers = COUNT(DISTINCT user_id) on upgrader_bet rows
 *   wins          = COUNT(upgrader_payout rows) — the backend only
 *                   emits this type on a winning upgrade, so the row
 *                   count holds even when the actual won value lives
 *                   in a different field
 *   losses        = bets − wins
 *   hitRate       = wins / bets * 100
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
 * scan over every Upgrader ledger row on each 60s dashboard refresh.
 * The 5-minute TTL matches the realized P&L snapshot's cache.
 */
const cachedUpgraderStats = unstable_cache(
  upgraderStatsInner,
  ["dashboard-upgrader-lifetime-v1"],
  { revalidate: 300, tags: ["dashboard-lifetime"] },
);

export const getUpgraderStats = cache(async (): Promise<UpgraderStats> => {
  return withTiming("dashboard.upgrader", () => cachedUpgraderStats());
});

async function upgraderStatsInner(): Promise<UpgraderStats> {
  const db = await getDb();
  const excluded = await getExcludedUserIds();
  const blacklistIdNotIn = blacklistNotInClause("id", excluded);

  // Single lifetime scan over upgrader_bet + upgrader_payout rows.
  // Same staff + creator + blacklist exclusion the Wager Attribution
  // chart and Organic Wager card use.
  type Row = Record<string, string>;
  const rows = await db.$queryRaw<Row[]>`
    WITH real_users AS (
      SELECT id FROM "user"
      WHERE role NOT IN ('admin', 'support', 'creator') ${Prisma.raw(blacklistIdNotIn)}
    )
    SELECT
      COALESCE(SUM(CASE WHEN type = 'upgrader_bet' THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS wager,
      COALESCE(SUM(CASE WHEN type = 'upgrader_payout' THEN GREATEST(ABS(amount::numeric), (balance_after - balance_before)::numeric, 0) ELSE 0 END), 0)::text AS payouts,
      COUNT(CASE WHEN type = 'upgrader_bet' THEN 1 END)::text AS bets,
      COUNT(DISTINCT CASE WHEN type = 'upgrader_bet' THEN user_id END)::text AS players,
      COUNT(CASE WHEN type = 'upgrader_payout' THEN 1 END)::text AS wins
    FROM ledger_transactions
    WHERE type IN ('upgrader_bet', 'upgrader_payout')
      AND status = 'completed'
      AND user_id IN (SELECT id FROM real_users)
  `;

  const r = rows[0] ?? {};
  const num = (key: string): number => parseFloat(r[key] ?? "0") || 0;
  const wager = num("wager");
  const payouts = num("payouts");
  const bets = num("bets");
  const uniquePlayers = num("players");
  const wins = num("wins");
  // Losses are derived: every bet either won (had a positive payout) or
  // lost. Clamp at 0 in case wins count exceeds bets due to edge cases
  // (e.g. an upgrader_payout that lacks a matching bet).
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
