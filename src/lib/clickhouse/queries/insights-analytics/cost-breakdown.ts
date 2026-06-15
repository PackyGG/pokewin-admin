import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import type { MetricWindow } from "@/lib/metrics/queries";
import type { InsightsPeriod } from "@/lib/queries/insights-analytics/period";

import { CH_DB, chDateTime, customerScopeCte, toNumber } from "../_shared";
import { getWindowMetricsFromClickHouse } from "../window-metrics";

/**
 * Phase 2B — /insights/cost-breakdown comparison-mode twin, read from the
 * ClickHouse prod game mirror (`packy_prod`, PeerDB CDC).
 *
 * The Postgres source is `getCostBreakdown` in
 * `src/lib/queries/insights-analytics/cost-breakdown.ts`, an ASSEMBLY of the
 * canonical metric layer. This twin reproduces its headline scalar money
 * figures — the cost-breakdown waterfall's checkpoints — by composing the
 * SAME canonical legs the Postgres assembly composes:
 *
 *   • The gaming-margin leg (wager / gamingPayout / GGR / NGR → rewardPayouts
 *     = GGR − NGR) is the canonical `getWindowMetrics({ window })`. Its already
 *     parity-validated ClickHouse twin `getWindowMetricsFromClickHouse`
 *     (Phase 2A) is REUSED verbatim, so this surface inherits that leg's
 *     proven cent parity.
 *   • The balance-sheet BRIDGE terms (card withdrawals shipped + inventory δ +
 *     voucher δ) mirror `getBridgeTerms` EXACTLY (three single-table window
 *     aggregates over the SAME real-customer scope).
 *   • The windowed realized P&L (`pnl`) mirrors `calculateWindowedPnl`
 *     EXACTLY — the five-term windowed-delta formula
 *     `deposits − withdrawals − Δbalance − Δinventory − Δvouchers`.
 *
 *   totalCost = totalWager − pnl  (derived, exactly as the PG assembly does).
 *
 * SCOPE NOTE — the PG `getCostBreakdown` runs the gaming-margin leg through the
 * canonical `getMetricsScope` (staff + creators dropped wholesale by role +
 * the admin blacklist), and runs `getBridgeTerms` / `calculateWindowedPnl`
 * with `excludeUserIds = blacklist ∪ liveCreatorIds`. Excluding every
 * creator-role user id is identical to dropping `role = 'creator'`, so all
 * three legs resolve to the SAME population: `role NOT IN
 * ('admin','support','creator')` + the admin blacklist. That is exactly the
 * shared `customerScopeCte` real-users CTE — used here for the bridge + pnl
 * legs, and matched by `getWindowMetricsFromClickHouse`'s own wholesale-drop
 * CTE — so logged drift reflects engine / CDC-lag only, not a scope change.
 *
 * IMPORTANT — this twin mirrors the WINDOWED `calculateWindowedPnl` (the page's
 * "Net result (this period)"), NOT the lifetime balance-sheet snapshot
 * `getRealizedPnlSnapshot` the page renders separately above the waterfall
 * (that lifetime leg has its own twin `getRealizedPnlSnapshotFromClickHouse` +
 * `compareRealizedPnl`). The two are different metrics; mirroring the windowed
 * one is what makes this surface's drift meaningful.
 *
 * ClickHouse correctness (PeerDB / SharedReplacingMergeTree mirrors):
 *   • Dedup latest row per id with FINAL on every public_* table.
 *   • Drop soft-deleted rows with `_peerdb_is_deleted = 0` everywhere.
 *   • Money stays Decimal end-to-end — toString(sum(...)) in SQL, toNumber()
 *     in TS — never Float / toFloat, so parity is exact to the cent.
 *   • The Postgres `jsonb` `metadata` column is mirrored as a ClickHouse
 *     Nullable(String); `metadata->>'key'` maps to `JSONExtractString`.
 *
 * The blacklist is passed IN by the caller (resolved from the admin DB via
 * getExcludedUserIds) so this module never imports a Postgres/Prisma client
 * (directly or transitively) — it is a pure ClickHouse read. The window cutoff
 * is the SAME canonical `periodToCutoff` value the Postgres path computed
 * (carried in `CostBreakdown.cutoffIso`), so the window is byte-identical and
 * carries no render-time `now` skew.
 */

export type CostBreakdownComparable = {
  totalWager: number;
  gamingPayouts: number;
  ggr: number;
  ngr: number;
  rewardPayouts: number;
  cardWithdrawals: number;
  inventoryDelta: number;
  voucherDelta: number;
  pnl: number;
  totalCost: number;
};

/** stats-excluded adjustment categories — netted out of the P&L balance-delta
 * term (mirrors `statsExcludedAdjustmentSqlPredicate`). Inlined as raw strings
 * so this read never imports `@/lib/balance-adjustment-categories` (which pulls
 * the Prisma browser sentinel) — keeping the CQRS boundary Prisma-free. */
const STATS_EXCLUDED_CATEGORIES_SQL = "('official_stream','remove_locked_balance')";

type PnlLedgerRow = {
  deposits: string;
  manual_wd: string;
  balance_change: string;
};
type PnlCardRow = { card_wd: string };
type PnlInvRow = { obtained: string; disposed: string };
type PnlVchRow = { issued: string; claimed: string };
type RemovalCandidateRow = { ref_id: string; amt: string };
type ExistingIdRow = { id: string };

/**
 * The `getBridgeTerms` twin — card withdrawals shipped + inventory δ + voucher
 * δ for the window, mirroring the PG SQL EXACTLY (note the
 * `COALESCE(completed_at, shipped_at)` order — the bridge differs from the P&L
 * leg, which uses `COALESCE(shipped_at, completed_at)`).
 */
async function getBridgeTermsFromClickHouse(
  params: Record<string, unknown>,
  scopeCte: string,
): Promise<{
  cardWithdrawals: number;
  inventoryDelta: number;
  voucherDelta: number;
}> {
  const cardSql = `
    WITH ${scopeCte}
    SELECT toString(sum(cwr.total_value_usd)) AS card_wd
    FROM ${CH_DB}.public_card_withdrawal_requests AS cwr FINAL
    WHERE cwr._peerdb_is_deleted = 0
      AND cwr.status IN ('completed','shipped')
      AND coalesce(cwr.completed_at, cwr.shipped_at) >= {cutoff:DateTime64(6)}
      AND cwr.user_id IN (SELECT id FROM real_users)`;

  // ClickHouse `if()` zero literal MUST be Decimal-typed (`toDecimal128(0, 2)`),
  // never the bare int `0`. With a non-constant condition, `if(cond, 0, <Decimal>)`
  // (or `if(cond, <Decimal>, 0)`) resolves the common branch type to a SCALE-0
  // Decimal and TRUNCATES cents off the Decimal branch — silently dropping every
  // fractional dollar across the SUM. `toDecimal128(0, 2)` keeps both branches at
  // scale 2 so money stays cent-exact. (See the equivalent `Decimal(20,2)`
  // columns; the wider `toDecimal128` promotes to Decimal(38,2), scale preserved.)
  const invSql = `
    WITH ${scopeCte}
    SELECT
      toString(sum(if(ui.obtained_at >= {cutoff:DateTime64(6)}, ui.value_at_obtained, toDecimal128(0, 2)))) AS inv_obtained,
      toString(sum(if(ui.sold_at >= {cutoff:DateTime64(6)} OR ui.exchanged_at >= {cutoff:DateTime64(6)}, ui.value_at_obtained, toDecimal128(0, 2)))) AS inv_disposed
    FROM ${CH_DB}.public_user_inventory AS ui FINAL
    WHERE ui._peerdb_is_deleted = 0
      AND (ui.obtained_at >= {cutoff:DateTime64(6)} OR ui.sold_at >= {cutoff:DateTime64(6)} OR ui.exchanged_at >= {cutoff:DateTime64(6)})
      AND ui.user_id IN (SELECT id FROM real_users)`;

  const vchSql = `
    WITH ${scopeCte}
    SELECT
      toString(sum(if(v.created_at >= {cutoff:DateTime64(6)}, v.value, toDecimal128(0, 2)))) AS vch_issued,
      toString(sum(if(v.claimed_at >= {cutoff:DateTime64(6)}, v.value, toDecimal128(0, 2)))) AS vch_claimed
    FROM ${CH_DB}.public_vouchers AS v FINAL
    WHERE v._peerdb_is_deleted = 0
      AND (v.created_at >= {cutoff:DateTime64(6)} OR v.claimed_at >= {cutoff:DateTime64(6)})
      AND v.user_id IN (SELECT id FROM real_users)`;

  const [card, inv, vch] = await Promise.all([
    clickhouseRead.query<{ card_wd: string }>({
      queryName: "insightsCostBreakdown.bridge.cardWithdrawals",
      sql: cardSql,
      params,
    }),
    clickhouseRead.query<{ inv_obtained: string; inv_disposed: string }>({
      queryName: "insightsCostBreakdown.bridge.inventory",
      sql: invSql,
      params,
    }),
    clickhouseRead.query<{ vch_issued: string; vch_claimed: string }>({
      queryName: "insightsCostBreakdown.bridge.vouchers",
      sql: vchSql,
      params,
    }),
  ]);

  return {
    cardWithdrawals: toNumber(card[0]?.card_wd),
    inventoryDelta:
      toNumber(inv[0]?.inv_obtained) - toNumber(inv[0]?.inv_disposed),
    voucherDelta:
      toNumber(vch[0]?.vch_issued) - toNumber(vch[0]?.vch_claimed),
  };
}

/**
 * Ledger-only admin-removal disposal term — the twin of
 * `adminInventoryRemovalDisposedSql` / `adminVoucherRemovalClaimedSql`: Σ
 * |amount| over completed `admin_balance_adjustment` rows in the window whose
 * `metadata.kind = <kind>` and whose referenced item id (`metadata.<refKey>`)
 * NO LONGER exists in the live `<itemTable>` (the row was hard-deleted before
 * sold_at/claimed_at stamping). Implemented bounded: first the (few) candidate
 * rows grouped by referenced id, then a single existence check over only those
 * ids — so it never materialises the whole item table.
 */
async function getAdminRemovalDisposed(
  kind: "inventory_removal" | "voucher_removal",
  refKey: "inventory_item_id" | "voucher_id",
  itemTable: "public_user_inventory" | "public_vouchers",
  params: Record<string, unknown>,
  scopeCte: string,
  queryTag: string,
): Promise<number> {
  const candidatesSql = `
    WITH ${scopeCte}
    SELECT
      JSONExtractString(lt.metadata, '${refKey}') AS ref_id,
      toString(sum(abs(lt.amount))) AS amt
    FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
    WHERE lt._peerdb_is_deleted = 0
      AND lt.status = 'completed'
      AND lt.created_at >= {cutoff:DateTime64(6)}
      AND lt.type = 'admin_balance_adjustment'
      AND JSONExtractString(lt.metadata, 'kind') = '${kind}'
      AND lt.user_id IN (SELECT id FROM real_users)
    GROUP BY ref_id`;

  const candidates = await clickhouseRead.query<RemovalCandidateRow>({
    queryName: `${queryTag}.candidates`,
    sql: candidatesSql,
    params,
  });
  if (candidates.length === 0) return 0;

  const refIds = candidates.map((c) => c.ref_id);
  const existingSql = `
    SELECT toString(id) AS id
    FROM ${CH_DB}.${itemTable} FINAL
    WHERE _peerdb_is_deleted = 0
      AND toString(id) IN {refIds:Array(String)}`;
  const existing = await clickhouseRead.query<ExistingIdRow>({
    queryName: `${queryTag}.existing`,
    sql: existingSql,
    params: { refIds },
  });
  const existingSet = new Set(existing.map((e) => e.id));

  // Sum |amount| for candidates whose referenced item is gone — NOT EXISTS.
  return candidates.reduce(
    (acc, c) => (existingSet.has(c.ref_id) ? acc : acc + toNumber(c.amt)),
    0,
  );
}

/**
 * The `calculateWindowedPnl` twin — five-term windowed-delta house P&L over
 * `[cutoff, now)`, mirroring the PG SQL EXACTLY:
 *   pnl = deposits − (manualWd + cardWd) − balanceΔ − inventoryΔ − voucherΔ
 */
async function getWindowedPnlFromClickHouse(
  params: Record<string, unknown>,
  scopeCte: string,
): Promise<number> {
  // `toDecimal128(0, 2)` (never bare int `0`) keeps every `if()` branch at
  // Decimal scale 2 — see the note in getBridgeTermsFromClickHouse. The
  // balance_change `if(<cond>, 0, balance_after - balance_before)` is the case
  // that actually truncated cents with a bare `0`; the `IN (...)` list already
  // excludes empty/missing categories, so no explicit `IS NOT NULL` guard is
  // needed (mirrors the PG `statsExcludedAdjustmentSqlPredicate` outcome).
  const ledgerSql = `
    WITH ${scopeCte}
    SELECT
      toString(sum(if(lt.type = 'deposit', lt.amount, toDecimal128(0, 2)))) AS deposits,
      toString(sum(if(
        lt.type = 'admin_balance_adjustment'
        AND lt.balance_after < lt.balance_before
        AND lt.description ILIKE 'Manual withdrawal:%',
        lt.amount, toDecimal128(0, 2)
      ))) AS manual_wd,
      toString(sum(if(
        lt.type = 'admin_balance_adjustment'
        AND JSONExtractString(lt.metadata, 'adjustment_category') IN ${STATS_EXCLUDED_CATEGORIES_SQL},
        toDecimal128(0, 2), lt.balance_after - lt.balance_before
      ))) AS balance_change
    FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
    WHERE lt._peerdb_is_deleted = 0
      AND lt.status = 'completed'
      AND lt.created_at >= {cutoff:DateTime64(6)}
      AND lt.user_id IN (SELECT id FROM real_users)`;

  const cardSql = `
    WITH ${scopeCte}
    SELECT toString(sum(cwr.total_value_usd)) AS card_wd
    FROM ${CH_DB}.public_card_withdrawal_requests AS cwr FINAL
    WHERE cwr._peerdb_is_deleted = 0
      AND cwr.status IN ('completed','shipped')
      AND coalesce(cwr.shipped_at, cwr.completed_at) >= {cutoff:DateTime64(6)}
      AND cwr.user_id IN (SELECT id FROM real_users)`;

  const invSql = `
    WITH ${scopeCte}
    SELECT
      toString(sum(if(ui.obtained_at >= {cutoff:DateTime64(6)}, ui.value_at_obtained, toDecimal128(0, 2)))) AS obtained,
      toString(sum(if(ui.sold_at >= {cutoff:DateTime64(6)} OR ui.exchanged_at >= {cutoff:DateTime64(6)}, ui.value_at_obtained, toDecimal128(0, 2)))) AS disposed
    FROM ${CH_DB}.public_user_inventory AS ui FINAL
    WHERE ui._peerdb_is_deleted = 0
      AND (ui.obtained_at >= {cutoff:DateTime64(6)} OR ui.sold_at >= {cutoff:DateTime64(6)} OR ui.exchanged_at >= {cutoff:DateTime64(6)})
      AND ui.user_id IN (SELECT id FROM real_users)`;

  const vchSql = `
    WITH ${scopeCte}
    SELECT
      toString(sum(if(v.created_at >= {cutoff:DateTime64(6)}, v.value, toDecimal128(0, 2)))) AS issued,
      toString(sum(if(v.claimed_at >= {cutoff:DateTime64(6)}, v.value, toDecimal128(0, 2)))) AS claimed
    FROM ${CH_DB}.public_vouchers AS v FINAL
    WHERE v._peerdb_is_deleted = 0
      AND (v.created_at >= {cutoff:DateTime64(6)} OR v.claimed_at >= {cutoff:DateTime64(6)})
      AND v.user_id IN (SELECT id FROM real_users)`;

  const [ledger, card, inv, vch, adminInvRemoval, adminVchRemoval] =
    await Promise.all([
      clickhouseRead.query<PnlLedgerRow>({
        queryName: "insightsCostBreakdown.pnl.ledger",
        sql: ledgerSql,
        params,
      }),
      clickhouseRead.query<PnlCardRow>({
        queryName: "insightsCostBreakdown.pnl.cardWithdrawals",
        sql: cardSql,
        params,
      }),
      clickhouseRead.query<PnlInvRow>({
        queryName: "insightsCostBreakdown.pnl.inventory",
        sql: invSql,
        params,
      }),
      clickhouseRead.query<PnlVchRow>({
        queryName: "insightsCostBreakdown.pnl.vouchers",
        sql: vchSql,
        params,
      }),
      getAdminRemovalDisposed(
        "inventory_removal",
        "inventory_item_id",
        "public_user_inventory",
        params,
        scopeCte,
        "insightsCostBreakdown.pnl.invRemoval",
      ),
      getAdminRemovalDisposed(
        "voucher_removal",
        "voucher_id",
        "public_vouchers",
        params,
        scopeCte,
        "insightsCostBreakdown.pnl.vchRemoval",
      ),
    ]);

  const deposits = toNumber(ledger[0]?.deposits);
  const manualWd = toNumber(ledger[0]?.manual_wd);
  const balanceChange = toNumber(ledger[0]?.balance_change);
  const cardWd = toNumber(card[0]?.card_wd);
  const inventoryChange =
    toNumber(inv[0]?.obtained) - (toNumber(inv[0]?.disposed) + adminInvRemoval);
  const voucherChange =
    toNumber(vch[0]?.issued) - (toNumber(vch[0]?.claimed) + adminVchRemoval);

  return (
    deposits -
    (manualWd + cardWd) -
    balanceChange -
    inventoryChange -
    voucherChange
  );
}

/**
 * ClickHouse twin of the cost-breakdown waterfall's headline scalar money
 * figures (see module header). `period` selects the lifetime (`since = null`)
 * vs finite gaming-margin window; `cutoff` is the canonical `periodToCutoff`
 * value the Postgres path used (from `CostBreakdown.cutoffIso`), reused
 * verbatim for the bridge + pnl legs so the window is byte-identical.
 */
export async function getCostBreakdownComparableFromClickHouse(
  period: InsightsPeriod,
  cutoff: Date,
  blacklist: string[],
): Promise<CostBreakdownComparable> {
  const hasBlacklist = blacklist.length > 0;
  const scopeCte = customerScopeCte({ hasBlacklist });
  const cutoffLiteral = chDateTime(cutoff);
  const params: Record<string, unknown> = {
    blacklist,
    cutoff: cutoffLiteral,
  };

  // Gaming-margin leg: the canonical window. Lifetime ("all") is unbounded
  // (since = null) exactly as `getCostBreakdown` builds its MetricWindow;
  // finite periods use the canonical cutoff.
  const metricWindow: MetricWindow = {
    since: period === "all" ? null : cutoff,
  };

  const [metrics, bridge, pnl] = await Promise.all([
    getWindowMetricsFromClickHouse(metricWindow, blacklist),
    getBridgeTermsFromClickHouse(params, scopeCte),
    getWindowedPnlFromClickHouse(params, scopeCte),
  ]);

  const totalWager = metrics.wager;
  const ggr = metrics.ggr;
  const ngr = metrics.ngr;

  return {
    totalWager,
    gamingPayouts: metrics.gamingPayout,
    ggr,
    ngr,
    rewardPayouts: ggr - ngr,
    cardWithdrawals: bridge.cardWithdrawals,
    inventoryDelta: bridge.inventoryDelta,
    voucherDelta: bridge.voucherDelta,
    pnl,
    totalCost: totalWager - pnl,
  };
}
