import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import { CH_DB, customerScopeCte, toNumber } from "../_shared";

/**
 * Phase 2B — Lifetime Upgrader stats, read from the ClickHouse prod game
 * mirror (`packy_prod`, PeerDB CDC).
 *
 * Twin of the canonical Postgres `getUpgraderStats` (src/lib/queries/
 * dashboard-upgrader.ts), which derives its presentation stats from
 * `upgraderMetrics({ since: null })` (src/lib/metrics/queries.ts). Returns the
 * SAME {@link DashboardUpgraderStats} shape so comparison mode can diff
 * field-for-field.
 *
 * SOURCE: `upgrader_games` (bet_amount / won_amount / user_id) — the
 * owner-confirmed upgrader source of truth. Lifetime window (no time bound),
 * matching the PG twin's `since: null`.
 *
 * ─── Scope (mirrors the PG twin EXACTLY — 3-role wholesale) ───────────
 *
 * `role NOT IN ('admin','support','creator')` + the excluded-users blacklist.
 * The upgrader leg uses the canonical CUSTOMER scope (creators DROPPED), unlike
 * the balance-sheet P&L family — so this twin uses the shared wholesale
 * `customerScopeCte`.
 *
 * Derived ratios (edge / avgBet / hitRate) are computed in TS EXACTLY as the
 * PG twin computes them, from the same primitives.
 *
 * ClickHouse correctness: FINAL + `_peerdb_is_deleted = 0`; money stays Decimal
 * (toString(sum(...)) → toNumber, never Float); blacklist passed IN so the
 * module never imports a Postgres client.
 */

type DashboardUpgraderStats = {
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

type Row = {
  wager: string;
  payout: string;
  bets: string;
  players: string;
  wins: string;
};

export async function getUpgraderStatsFromClickHouse(
  blacklist: string[],
): Promise<DashboardUpgraderStats> {
  const hasBlacklist = blacklist.length > 0;
  const params: Record<string, unknown> = { blacklist };

  const sql = `
    WITH ${customerScopeCte({ hasBlacklist })}
    SELECT
      toString(sum(ug.bet_amount))            AS wager,
      toString(sum(ug.won_amount))            AS payout,
      toString(count())                       AS bets,
      toString(uniqExact(ug.user_id))         AS players,
      toString(sum(if(ug.won_amount > 0, 1, 0))) AS wins
    FROM ${CH_DB}.public_upgrader_games AS ug FINAL
    WHERE ug._peerdb_is_deleted = 0
      AND ug.user_id IN (SELECT id FROM real_users)`;

  const rows = await clickhouseRead.query<Row>({
    queryName: "dashboard.upgraderStats",
    sql,
    params,
  });

  const r = rows[0];
  const wager = toNumber(r?.wager);
  const payouts = toNumber(r?.payout);
  const bets = toNumber(r?.bets);
  const wins = toNumber(r?.wins);
  const uniquePlayers = toNumber(r?.players);
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
    losses: Math.max(0, bets - wins),
    hitRate: bets > 0 ? (wins / bets) * 100 : 0,
  };
}
