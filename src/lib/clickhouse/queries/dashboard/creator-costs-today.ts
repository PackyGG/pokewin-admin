import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import { CH_DB, chDateTime, toNumber } from "../_shared";

/**
 * Phase 2B — Dashboard "Creators Costs (today)" tile, read from the ClickHouse
 * prod game mirror (`packy_prod`, PeerDB CDC).
 *
 * Twin of the canonical Postgres `getCreatorCostsToday`
 * (src/lib/queries/dashboard-creator-costs-today.ts). Mirrors the SAME six
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
 *   • sponsoredBattles = Σ |ledger.amount| WHERE type='creator_fill_spend_battle'
 *                          AND status='completed', created_at >= since. Sibling
 *                          leg of `tips` from the same house-funded tips/sponsor
 *                          pool (owner, 2026-07-02) — see tips-sponsor-spend.ts.
 *   • leaderboardGross = Σ |ledger.amount| WHERE type='affiliate_leaderboard_prize'
 *                          AND status='completed', created_at >= since (FULL gross).
 *   • affiliate        = Σ |ledger.amount| WHERE type='affiliate_claim'
 *                          AND status='completed', created_at >= since. MOVED
 *                          WHOLESALE here from the Reward Costs twin (owner,
 *                          2026-07-02) — see reward-costs-today.ts.
 *   • total            = creatorWithdrawals + tips + sponsoredBattles
 *                          + leaderboardGross + affiliate.
 *
 * ─── Scope (mirrors the PG twin EXACTLY — blacklist ONLY) ─────────────
 *
 * The PG twin applies the admin-managed `excluded_users` BLACKLIST to the
 * receiving `user_id` on every line (so a blacklisted recipient never appears)
 * but does NOT drop staff/creator roles — creators are the legitimate subject
 * of creator costs (and, per the 2026-07-02 move, affiliate-code earners are
 * treated the same way). This twin mirrors that exactly: no real-customer CTE,
 * just the blacklist passed IN by the caller as a `NOT IN` residual filter on
 * each read's `user_id` (empty list → no clause, matching PG's empty-list
 * behavior).
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

type CreatorCostsTodayCh = {
  total: number;
  creatorWithdrawals: number;
  tips: number;
  sponsoredBattles: number;
  leaderboardGross: number;
  affiliate: number;
};

type VoucherRow = { fill_converted: string; multiplier_payouts: string };
type LedgerRow = {
  tips: string;
  sponsored_battles: string;
  leaderboard_gross: string;
  affiliate: string;
};

export async function getCreatorCostsTodayFromClickHouse(
  since: Date,
  blacklist: string[],
): Promise<CreatorCostsTodayCh> {
  const cutoff = chDateTime(since);
  const hasBlacklist = blacklist.length > 0;
  const params: Record<string, unknown> = { cutoff, blacklist };
  // Blacklist residual filter — mirrors the PG `NOT IN (...)` on the receiving
  // user_id. Empty list → no clause (matches PG's empty-list behavior).
  const voucherBlacklistClause = hasBlacklist
    ? "AND v.user_id NOT IN {blacklist:Array(String)}"
    : "";
  const ledgerBlacklistClause = hasBlacklist
    ? "AND lt.user_id NOT IN {blacklist:Array(String)}"
    : "";

  // Converted deal payouts today — fill-conversion + multiplier payout vouchers
  // minted in the window. `sumIf` keeps the Decimal scale (no §5b truncation).
  const voucherSql = `
    SELECT
      toString(sumIf(v.value, v.origin = 'creator_fill_conversion'))   AS fill_converted,
      toString(sumIf(v.value, v.origin = 'creator_multiplier_payout')) AS multiplier_payouts
    FROM ${CH_DB}.public_vouchers AS v FINAL
    WHERE v._peerdb_is_deleted = 0
      AND v.created_at >= {cutoff:DateTime64(6)}
      AND v.origin IN ('creator_fill_conversion','creator_multiplier_payout')
      ${voucherBlacklistClause}`;

  // Tips (creator-funded fill-spend tips) + sponsored battles (creator-funded
  // fill-spend battle sponsorships — sibling leg of tips from the same
  // house-funded tips/sponsor pool) + the FULL leaderboard prize gross +
  // affiliate commissions, all as Σ |amount| over completed ledger rows in the
  // window. `affiliate_claim` MOVED WHOLESALE here (owner, 2026-07-02).
  const ledgerSql = `
    SELECT
      toString(sumIf(abs(lt.amount), lt.type = 'creator_fill_spend_tip'))     AS tips,
      toString(sumIf(abs(lt.amount), lt.type = 'creator_fill_spend_battle'))  AS sponsored_battles,
      toString(sumIf(abs(lt.amount), lt.type = 'affiliate_leaderboard_prize')) AS leaderboard_gross,
      toString(sumIf(abs(lt.amount), lt.type = 'affiliate_claim'))            AS affiliate
    FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
    WHERE lt._peerdb_is_deleted = 0
      AND lt.status = 'completed'
      AND lt.created_at >= {cutoff:DateTime64(6)}
      AND lt.type IN ('creator_fill_spend_tip','creator_fill_spend_battle','affiliate_leaderboard_prize','affiliate_claim')
      ${ledgerBlacklistClause}`;

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
  const sponsoredBattles = toNumber(led[0]?.sponsored_battles);
  const leaderboardGross = toNumber(led[0]?.leaderboard_gross);
  const affiliate = toNumber(led[0]?.affiliate);
  const total =
    creatorWithdrawals + tips + sponsoredBattles + leaderboardGross + affiliate;

  return {
    total,
    creatorWithdrawals,
    tips,
    sponsoredBattles,
    leaderboardGross,
    affiliate,
  };
}
