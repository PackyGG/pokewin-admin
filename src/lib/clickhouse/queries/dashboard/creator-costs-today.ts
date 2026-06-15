import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import { CH_DB, chDateTime, toNumber } from "../_shared";

/**
 * Phase 2B — Dashboard "Creators Costs (today)" tile, read from the ClickHouse
 * prod game mirror (`packy_prod`, PeerDB CDC).
 *
 * Twin of the canonical Postgres `getCreatorCostsToday`
 * (src/lib/queries/dashboard-creator-costs-today.ts). Mirrors the SAME four
 * money figures the card surfaces, over the SAME window `[since, now)` (today
 * 00:00 UTC — the PG path's `utcStartOfDay`, passed in as `since`):
 *
 *   • creatorWithdrawals = Σ vouchers.value WHERE origin='creator_fill_conversion'
 *                          (fill conversions; same source as
 *                          `getConvertedFillSessionsInWindow`)
 *                        + Σ vouchers.value WHERE origin='creator_multiplier_payout'
 *                          (multiplier deal payouts), both by created_at >= since.
 *   • tips             = Σ |ledger.amount| WHERE type='creator_fill_spend_tip'
 *                          AND status='completed', created_at >= since.
 *   • leaderboardGross = Σ |ledger.amount| WHERE type='affiliate_leaderboard_prize'
 *                          AND status='completed', created_at >= since (FULL gross).
 *   • total            = creatorWithdrawals + tips + leaderboardGross.
 *
 * ─── Scope (mirrors the PG twin EXACTLY — NO user scope) ──────────────
 *
 * The PG twin applies NO staff/blacklist/role filter: these are creator-fill /
 * deal / leaderboard spend legs (the receiving user is whoever the creator
 * paid/sponsored), so the gross house spend is the honest figure. This twin
 * mirrors that exactly — no real-customer CTE, no blacklist.
 *
 * ClickHouse correctness (PeerDB / SharedReplacingMergeTree mirrors):
 *   • FINAL + `_peerdb_is_deleted = 0` on every mirrored table.
 *   • Money stays Decimal end-to-end — `sumIf` over the Decimal column (which
 *     preserves the column scale, unlike `if(cond, 0, …)`) → toString → toNumber,
 *     never Float.
 *   • `origin` / `type` are mirrored as Strings, so the PG enum `::text`
 *     comparisons map to plain string equality; a type/origin absent from the
 *     prod enum simply matches zero rows (matches the PG ENUM-SAFE `$0` read).
 */

export type CreatorCostsTodayCh = {
  total: number;
  creatorWithdrawals: number;
  tips: number;
  leaderboardGross: number;
};

type VoucherRow = { fill_converted: string; multiplier_payouts: string };
type LedgerRow = { tips: string; leaderboard_gross: string };

export async function getCreatorCostsTodayFromClickHouse(
  since: Date,
): Promise<CreatorCostsTodayCh> {
  const cutoff = chDateTime(since);
  const params: Record<string, unknown> = { cutoff };

  // Converted deal payouts today — fill-conversion + multiplier payout vouchers
  // minted in the window. `sumIf` keeps the Decimal scale (no §5b truncation).
  const voucherSql = `
    SELECT
      toString(sumIf(v.value, v.origin = 'creator_fill_conversion'))   AS fill_converted,
      toString(sumIf(v.value, v.origin = 'creator_multiplier_payout')) AS multiplier_payouts
    FROM ${CH_DB}.public_vouchers AS v FINAL
    WHERE v._peerdb_is_deleted = 0
      AND v.created_at >= {cutoff:DateTime64(6)}
      AND v.origin IN ('creator_fill_conversion','creator_multiplier_payout')`;

  // Tips (creator-funded fill-spend tips) + the FULL leaderboard prize gross,
  // both as Σ |amount| over completed ledger rows in the window.
  const ledgerSql = `
    SELECT
      toString(sumIf(abs(lt.amount), lt.type = 'creator_fill_spend_tip'))     AS tips,
      toString(sumIf(abs(lt.amount), lt.type = 'affiliate_leaderboard_prize')) AS leaderboard_gross
    FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
    WHERE lt._peerdb_is_deleted = 0
      AND lt.status = 'completed'
      AND lt.created_at >= {cutoff:DateTime64(6)}
      AND lt.type IN ('creator_fill_spend_tip','affiliate_leaderboard_prize')`;

  const [vch, led] = await Promise.all([
    clickhouseRead.query<VoucherRow>({
      queryName: "dashboard.creatorCostsToday.vouchers",
      sql: voucherSql,
      params,
    }),
    clickhouseRead.query<LedgerRow>({
      queryName: "dashboard.creatorCostsToday.ledger",
      sql: ledgerSql,
      params,
    }),
  ]);

  const creatorWithdrawals =
    toNumber(vch[0]?.fill_converted) + toNumber(vch[0]?.multiplier_payouts);
  const tips = toNumber(led[0]?.tips);
  const leaderboardGross = toNumber(led[0]?.leaderboard_gross);
  const total = creatorWithdrawals + tips + leaderboardGross;

  return { total, creatorWithdrawals, tips, leaderboardGross };
}
