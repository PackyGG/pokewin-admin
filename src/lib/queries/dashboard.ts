import { cache } from "react";
import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import { MS_PER_DAY, MS_PER_HOUR } from "@/lib/utils/time";
import {
  excludeStaffAndBlacklisted,
  blacklistNotInClause,
} from "./_blacklist";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { officialStreamAdjustmentSqlPredicate } from "@/lib/balance-adjustment-categories";
import { getRealizedPnlSnapshot } from "./_realized-pnl";
import { getCreatorSessionWindowsCte } from "./creator-session-windows";
// Canonical metric layer (single source of truth for GGR / wager / payout
// / scope). The dashboard's headline GGR + the GGR breakdown popover are
// migrated onto these — the inline `wager − Σ payout(19)` formula (which
// folded the 328k-row `card_sale` and the other NEUTRAL conversions into
// the payout side, and assumed a phantom ledger `upgrader_payout`) is
// gone. See src/lib/metrics/ledger-sets.ts for the verified booking model
// (CASE iii: gross-in via ledger, win via `user_inventory` delta).
import {
  WAGER_TYPES_SQL as METRICS_WAGER_TYPES_SQL,
  GAMING_PAYOUT_TYPES_SQL as METRICS_GAMING_PAYOUT_TYPES_SQL,
} from "@/lib/metrics";
import {
  getWindowMetrics,
  getGamingLegs,
  upgraderMetrics,
  type MetricWindow,
  type WindowMetrics,
} from "@/lib/metrics/queries";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
// Central canonical scope (staff + blacklist drop, creators kept,
// creator-on-session rows excluded via session windows). getGgrTopContributors
// is swept onto this so per-user GGR uses the SAME population as the
// headline — "one scope, fixed once".
import { getMetricsScope } from "@/lib/metrics/scope";
import {
  DASHBOARD_PERIOD_LABELS,
  DEFAULT_DASHBOARD_PERIOD,
  periodToCutoff,
  type DashboardPeriod,
} from "./dashboard-period";

// Re-export the client-safe period constants so existing call sites
// that import from "@/lib/queries/dashboard" don't have to change. The
// actual definitions live in dashboard-period.ts (no DB imports) so
// the <DashboardPeriodSelector> client component can pull them too.
export {
  DASHBOARD_PERIODS,
  DASHBOARD_PERIOD_LABELS,
  DEFAULT_DASHBOARD_PERIOD,
  parseDashboardPeriod,
  periodToCutoff,
} from "./dashboard-period";
export type { DashboardPeriod } from "./dashboard-period";

/**
 * Capped lifetime lookback (days) for the dashboard "all" (All time)
 * chip's headline GGR / NGR read.
 *
 * The dashboard exposes an "all" chip, but mapping it to a TRUE unbounded
 * window (`since: null`) makes the canonical `getWindowMetrics` /
 * `getGamingLegs` legs scan the ENTIRE ~400k-row `ledger_transactions`
 * history (plus the full `user_inventory` + `upgrader_games`) with no
 * lower bound — and on the dashboard that read had NO `safeQuery` timeout
 * and NO cache, so a slow full-history scan blocked the KPI strip until
 * Postgres returned or the platform killed the request. So "all" is now
 * bounded to the SAME capped lookback the `/ggr` page already uses for its
 * Lifetime chip (`GGR_LIFETIME_LOOKBACK_DAYS = 365` in
 * `src/lib/queries/ggr.ts`, itself mirroring the canonical 365-day guard
 * shared by deposit-bonus `_shared.ts` / rakeback ROI / `signup/daily.ts`
 * / `suspicious.ts`). The value is inlined here as a local constant —
 * rather than imported from the `server-only` `ggr.ts` — to keep this
 * module decoupled and free of a `server-only` import (client components
 * pull this module's TYPES via `import type`), the SAME way `suspicious.ts`
 * / `signup/daily.ts` inline `365` with a reference comment. Keep this in
 * sync with the canonical 365-day guard.
 */
const DASHBOARD_GGR_LIFETIME_LOOKBACK_DAYS = 365;

/**
 * Convert a dashboard period chip to the canonical `MetricWindow` the
 * `@/lib/metrics` query builders take.
 *
 * Every rolling chip maps to its `periodToCutoff` cutoff. The "all" chip
 * does NOT map to an unbounded `{ since: null }` — that triggers a
 * full-history scan in the canonical GGR/NGR legs that (on the dashboard)
 * ran without a timeout or cache and could hang the KPI strip (see
 * {@link DASHBOARD_GGR_LIFETIME_LOOKBACK_DAYS}). Instead "all" maps to a
 * BOUNDED cutoff `now − 365 days`, matching how `/ggr`'s Lifetime chip is
 * capped (`ggrWindowToMetricWindow`). SEMANTIC NOTE: this makes the
 * dashboard's "All time" headline GGR / NGR a TRAILING-365-DAY figure
 * (identical to what `/ggr` Lifetime already reports), not a true
 * since-inception number.
 *
 * Used ONLY for the canonical `@/lib/metrics` GGR/NGR (+ upgrader) reads.
 * The period-bound `getPeriodAggregates` wager / deposit / withdrawal
 * tiles still use the epoch-sentinel `periodToCutoff` (a no-op cutoff that
 * does NOT change their existing all-time behaviour) — only the canonical
 * gaming-margin legs, which are the ones that did the unbounded scan, are
 * capped here.
 */
function periodToMetricWindow(
  period: DashboardPeriod,
  now: Date,
): MetricWindow {
  if (period !== "all") {
    return { since: periodToCutoff(period, now) };
  }
  // "all" → bounded 365-day lookback (NOT unbounded `since: null`) so the
  // canonical GGR/NGR legs never run a full-history scan on the dashboard.
  const since = new Date(
    now.getTime() - DASHBOARD_GGR_LIFETIME_LOOKBACK_DAYS * MS_PER_DAY,
  );
  return { since };
}

/**
 * Neutral all-zero fallback for the canonical headline window metrics —
 * the shape `getWindowMetrics` returns. Used when the headline GGR read
 * fails or times out (via {@link safeQuery}) so the dashboard still renders
 * a $0 gaming-margin tile instead of crashing the KPI strip.
 */
const EMPTY_WINDOW_METRICS: WindowMetrics = {
  wager: 0,
  gamingPayout: 0,
  ggr: 0,
  ngr: 0,
  rtp: null,
  houseEdge: null,
  bets: 0,
  rainWinTotal: 0,
  rainTipTotal: 0,
  rainHouseCost: 0,
};

/**
 * Shared inner read for the dashboard's headline GGR/NGR — resolves the
 * (capped, see `periodToMetricWindow`) window from the PERIOD STRING
 * itself, then calls the canonical `getWindowMetrics`.
 *
 * Crucially `now` is recomputed HERE (inside the cached fn) from the
 * period, NOT passed in: the `unstable_cache` key is the stable period
 * string + blacklist clause, never a per-millisecond Date. For the "all"
 * chip this means the 365-day lower bound is recomputed on each cache
 * MISS; within the cache TTL the sub-window drift is bounded (the SAME
 * tradeoff `cachedUserCounts` / `cachedLifetimeDepositMetrics` make with
 * their recomputed rolling cutoffs). `getWindowMetrics` resolves its own
 * real-customer scope (staff + blacklist) internally; `blacklistIdNotIn`
 * is threaded through purely as a cache-key discriminator so an
 * excluded-user change re-fetches within the TTL — matching every other
 * cached dashboard aggregate's key shape.
 */
async function windowMetricsForPeriodInner(
  period: DashboardPeriod,
  // Cache-key discriminator only (see doc above); not used in the read.
  _blacklistIdNotIn: string,
): Promise<WindowMetrics> {
  const window = periodToMetricWindow(period, new Date());
  return getWindowMetrics({ window });
}

// Lifetime ("all") headline GGR — 300s TTL. The "all" chip is now capped
// to a bounded 365-day window (see `periodToMetricWindow`), so this is a
// heavy-but-bounded scan; a 5-min cache keeps it off the hot path on the
// dashboard's 60s auto-refresh, consistent with the OTHER lifetime
// aggregates in this file (`cachedBalanceAggregates`, `cachedUserCounts`,
// …, all 300s).
const cachedLifetimeWindowMetrics = unstable_cache(
  windowMetricsForPeriodInner,
  ["dashboard-window-metrics-lifetime-v1"],
  { revalidate: 300, tags: ["dashboard-lifetime"] },
);

// Rolling-window headline GGR (1h … 30d) — 60s TTL so it stays close to
// live on the dashboard's 60s auto-refresh without re-running the gaming
// legs on every render. The period string is part of the cache key
// (passed as the first arg) so different rolling chips never collide.
const cachedRollingWindowMetrics = unstable_cache(
  windowMetricsForPeriodInner,
  ["dashboard-window-metrics-rolling-v1"],
  { revalidate: 60, tags: ["dashboard-activity"] },
);

/**
 * Headline GGR/NGR for the selected dashboard period, cached + bounded.
 *
 * Dispatches to the 300s ("all") or 60s (rolling) cache by period so the
 * two TTLs are honoured with module-level `unstable_cache` instances
 * (revalidate is fixed per instance). The window is capped for "all" (no
 * unbounded scan — see `periodToMetricWindow`). The CALLER additionally
 * wraps this in `safeQuery(..., REWARD_QUERY_TIMEOUT_MS)` so a cold-miss
 * scan that runs long degrades the headline tile to a $0 fallback instead
 * of hanging the whole KPI strip.
 */
function cachedWindowMetricsForPeriod(
  period: DashboardPeriod,
  blacklistIdNotIn: string,
): Promise<WindowMetrics> {
  return period === "all"
    ? cachedLifetimeWindowMetrics(period, blacklistIdNotIn)
    : cachedRollingWindowMetrics(period, blacklistIdNotIn);
}

/**
 * Single raw query that returns revenue (deposits), withdrawal, wager,
 * and the windowed-P&L building blocks for the SELECTED period
 * only. Previously this computed all 9 windows at once (1h … all) in
 * one massive CASE-WHEN scan — fast in round-trip count but very heavy
 * in plan + execution, because every aggregate had to evaluate 9 time
 * predicates per row. Collapsing to ONE cutoff lets the planner index-
 * scan just the relevant slice of `ledger_transactions`, and the
 * column list shrinks from ~60 to ~12.
 *
 * The cutoff is a TRUE ROLLING WINDOW from `now` (e.g. 24h = `now − 24h`,
 * NOT UTC midnight). The "all" period maps to the unix epoch so the
 * `created_at >= cutoff` filter degrades to a no-op without needing a
 * special branch in the SQL.
 *
 * Row shape: one text column per metric. Caller converts to number via
 * toNumber / parseFloat.
 *
 * Note on withdrawals: revenue/wager come from `ledger_transactions`,
 * but withdrawals come from `card_withdrawal_requests` (status IN
 * completed/shipped) so the StatCard matches the PnL formula's source of
 * truth. Some pre-Fireblocks completions never got their ledger entry's
 * status flipped to 'completed' — those withdrawals are real (money left
 * the house) but a ledger-based query misses them. The request table is
 * the authoritative record.
 *
 * GGR is NO LONGER computed here. The headline GGR now comes from the
 * canonical `@/lib/metrics` inventory-delta definition (`getWindowMetrics`
 * in `dashboardStatsInner`) — wager (ledger) minus the
 * `user_inventory.value_at_obtained` win delta plus `|battle_refund|`,
 * with the central real-customer + borrow-corrected scope. The old inline
 * `wager − Σ payout(19)` aggregate that lived in this query subtracted the
 * NEUTRAL card/voucher conversions (card_sale alone was hundreds of
 * thousands of rows) and a phantom ledger `upgrader_payout`; both are
 * removed. This query still produces the wager DISPLAY tiles + the
 * windowed-P&L building blocks.
 *
 * The wager-side type list is sourced from the canonical
 * `WAGER_TYPES` (`pack_opening`/`battle_bet`/`battle_sponsorship`) — the
 * phantom `upgrader_bet` ledger member is gone (upgrader lives only in
 * `upgrader_games`; the enum doesn't even carry `upgrader_bet` on a
 * migration-lagged DB, so referencing it threw `22P02`). Upgrader wager is
 * surfaced separately from `upgrader_games` via the canonical
 * `upgraderMetrics`. `withdrawal_shipping_fee` is NOT in the wager list
 * (it is a FEE, not a stake) — so this tile and the canonical GGR wager
 * leg now agree on the fee (closes M3).
 */
function getPeriodAggregates(
  db: PrismaClient,
  // Single rolling cutoff for the selected period. `new Date(0)` for
  // the "all" period.
  cutoff: Date,
  blacklistIdNotIn: string,
  // A `session_windows(uid, win_start, win_end)` CTE definition (built
  // by getCreatorSessionWindowsCte) — every creator deal/stream session.
  // Wagers a creator made inside one of these windows are dropped from
  // the customer wager figure.
  sessionWindowsCte: string,
) {
  // Wager-side type set — the canonical `WAGER_TYPES` from
  // `@/lib/metrics` (`pack_opening`/`battle_bet`/`battle_sponsorship`),
  // rendered as a pre-quoted SQL `IN` list. Hardcoded enum strings (no
  // external input) so interpolation via Prisma.raw is injection-safe.
  // This is the SAME set the canonical GGR wager leg uses, so the wager
  // DISPLAY tiles below reconcile with the headline GGR's wager leg
  // (closes M3 on the `withdrawal_shipping_fee` split — neither includes
  // the fee). The phantom `upgrader_bet` member is intentionally absent.
  const wagerTypesIn = Prisma.raw(METRICS_WAGER_TYPES_SQL);
  return db.$queryRaw<
    {
      revenue: string;
      withdrawal: string;
      // Period count of completed card_withdrawal_requests — pairs with
      // `withdrawal` so the Withdrawals KPI card can show "$X across N
      // withdrawals" in the title chip. Sourced from the same
      // `withdrawals` CTE as `withdrawal` so the count and amount always
      // match (status IN completed/shipped, effective_at within cutoff).
      withdrawal_count: string;
      wager: string;
      // Customer wager — wager MINUS wagers a creator made while live
      // on a deal/stream (house-funded "sponsored" play).
      wager_excl_session: string;
      // Customer GAMEPLAY wager broken down by ledger source (Packs /
      // Battles). These two sum to wager_excl_session. Upgrader is NOT a
      // ledger source — it is added on top from `upgrader_games` by the
      // caller (see `upgraderMetrics`), so it is not a column here.
      pack_wager_excl_session: string;
      battle_wager_excl_session: string;
      // Wager from users who did NOT join under an official creator
      // code AND are not creator on-stream play (NOT in_session AND
      // NOT under_creator). Pure organic customer wager.
      wager_organic: string;
      deposit_count: string;
      // Windowed balance-change components used by the period P&L
      // figure (was the 24h-only realizedPnl24h, now keyed on the
      // selected period via the same cutoff). Same `base` CTE as the
      // rest so these cost no extra round-trip. balance_after −
      // balance_before carries the signed delta on every completed
      // row; summing across the window gives Δbalance directly.
      balance_change: string;
      // admin_balance_adjustment rows that look like manual
      // withdrawals (description-tagged) in the same window — pulled
      // out so the period withdrawals figure can include manuals
      // alongside the card-withdrawal value already captured in
      // `withdrawal`.
      manual_wd: string;
      // Creator DEAL-PAYOUT cash-outs for the period — the Σ
      // `vouchers.value` of creator deal-payout vouchers
      // (`origin IN ('creator_fill_conversion','creator_multiplier_payout')`)
      // that are attached (`vouchers.id = ANY(cwr.voucher_ids)`) to a
      // completed/shipped `card_withdrawal_requests`, scoped by the
      // request's effective_at. This is the house's REAL creator cost —
      // deal payouts the creator has actually cashed out — NOT a creator's
      // personal balance cash-out. `creator_wd_count` is the COUNT of
      // distinct such withdrawal requests (≥1 deal-payout voucher) so the
      // KPI tile can read "$X across N deal-payout withdrawals". Disjoint
      // voucher origins → no double-count between the two payout types.
      creator_wd_amount: string;
      creator_wd_count: string;
    }[]
  >`
    WITH real_users AS (
      SELECT u.id, u.role, u.referred_by,
             -- under_creator flags users who joined under an official
             -- creator code — referred_by points to a user with role
             -- 'creator'. NULL referred_by (organic signup) is false.
             -- Computed once per user here so the per-row CASE on the
             -- ledger scan stays cheap.
             EXISTS (
               SELECT 1 FROM "user" ref
               WHERE ref.id = u.referred_by AND ref.role = 'creator'
             ) AS under_creator
      FROM "user" u
      WHERE u.role NOT IN ('admin', 'support') ${Prisma.raw(blacklistIdNotIn)}
    ),
    ${Prisma.raw(sessionWindowsCte)},
    base AS (
      -- in_session marks a wager a creator made while live on a deal/
      -- stream — its created_at falls inside one of that creator's
      -- session windows. Creators wager house-funded "sponsored"
      -- balance on stream, which is not a real customer bet, so the
      -- customer wager figure drops these rows. The CASE keeps the
      -- EXISTS subquery off the hot path for non-creator rows.
      -- lt_balance_*/lt_description are aliased through the CTE so the
      -- 24h balance-change + manual-withdrawal sums at the bottom of
      -- this SELECT can reach them without re-joining the ledger.
      -- under_creator carries forward whether the wagering user joined
      -- under an official creator code — drives the wager_organic_*
      -- aggregate at the bottom of the SELECT.
      SELECT lt.user_id, lt.type, lt.amount::numeric AS amount, lt.created_at,
             lt.balance_after AS lt_balance_after,
             lt.balance_before AS lt_balance_before,
             lt.description AS lt_description,
             -- Carried so the balance_change aggregate can exclude
             -- fake-balance official_stream adjustments by category.
             lt.metadata AS lt_metadata,
             ru.under_creator,
             CASE WHEN ru.role = 'creator'
                  THEN EXISTS (
                    SELECT 1 FROM session_windows sw
                    WHERE sw.uid = lt.user_id
                      AND lt.created_at >= sw.win_start
                      AND lt.created_at <  sw.win_end
                  )
                  ELSE false END AS in_session
      FROM ledger_transactions lt
      JOIN real_users ru ON ru.id = lt.user_id
      WHERE lt.status = 'completed'
    ),
    withdrawals AS (
      SELECT
        cwr.total_value_usd::numeric AS amount,
        -- Use shipped_at as the "money out" timestamp when completed_at is
        -- not yet set (status='shipped'). For status='completed' both
        -- timestamps are usually populated; completed_at wins.
        COALESCE(cwr.completed_at, cwr.shipped_at) AS effective_at
      -- JOIN to real_users keeps the staff + blacklist exclusion on the
      -- withdrawals total (same population the rest of the aggregate uses).
      FROM card_withdrawal_requests cwr
      JOIN real_users ru ON ru.id = cwr.user_id
      WHERE cwr.status IN ('completed', 'shipped')
    ),
    -- Creator DEAL-PAYOUT cash-outs — the house's REAL creator cost that
    -- has actually walked out the door. Joins completed/shipped
    -- card_withdrawal_requests to the deal-payout vouchers they cashed out
    -- (vouchers.id ∈ cwr.voucher_ids) and keeps ONLY the two creator
    -- deal-payout voucher origins:
    --   • creator_fill_conversion   — the WEEKLY FILL program's end-of-
    --     session payout voucher (§2 of the creator model; the source the
    --     /creators "Converted" KPI reads).
    --   • creator_multiplier_payout — the MULTIPLIER deal's settled
    --     withdrawable payout voucher.
    -- These two origins are disjoint, so summing both never double-counts a
    -- voucher. The amount column is the VOUCHER value (vouchers.value), NOT
    -- the request's total_value_usd -- a single request can also carry the
    -- creator's personal (non-deal) vouchers / inventory, and only the
    -- deal-payout slice is a creator cost. effective_at is the request's
    -- money-out timestamp (completed_at, else shipped_at) so the period
    -- cutoff below filters on when the payout actually left, matching the
    -- ordinary withdrawals CTE. DISTINCT on (request, voucher) so a
    -- voucher listed twice in one request's array can't be summed twice;
    -- the request id is carried so the outer COUNT(DISTINCT) reports the
    -- number of withdrawal requests that cashed out >=1 deal-payout voucher.
    creator_deal_payouts AS (
      SELECT DISTINCT
        cwr.id AS request_id,
        v.id   AS voucher_id,
        v.value::numeric AS amount,
        COALESCE(cwr.completed_at, cwr.shipped_at) AS effective_at
      FROM card_withdrawal_requests cwr
      JOIN vouchers v ON v.id = ANY(cwr.voucher_ids)
      WHERE cwr.status IN ('completed', 'shipped')
        AND v.origin::text IN ('creator_fill_conversion', 'creator_multiplier_payout')
    )
    SELECT
      COALESCE(SUM(CASE WHEN type::text = 'deposit' AND created_at >= ${cutoff} THEN amount ELSE 0 END), 0)::text AS revenue,

      COALESCE((SELECT SUM(CASE WHEN effective_at >= ${cutoff} THEN amount ELSE 0 END) FROM withdrawals), 0)::text AS withdrawal,

      -- Period count of completed/shipped withdrawals — same
      -- withdrawals CTE / effective_at cutoff as the withdrawal amount,
      -- so the count + amount on the Withdrawals KPI card stay
      -- consistent (no separate roundtrip / no source-of-truth split).
      (SELECT COUNT(*) FROM withdrawals WHERE effective_at >= ${cutoff})::text AS withdrawal_count,

      -- Creator DEAL-PAYOUT cash-outs for the period — Σ voucher value of
      -- creator deal-payout vouchers (creator_fill_conversion +
      -- creator_multiplier_payout) attached to a completed/shipped
      -- withdrawal request, scoped by the request's effective_at. This is a
      -- REAL house creator cost (deal payouts the creator cashed out), NOT
      -- a creator's personal balance cash-out. Read from the
      -- creator_deal_payouts CTE (request × deal-payout voucher).
      COALESCE((SELECT SUM(CASE WHEN effective_at >= ${cutoff} THEN amount ELSE 0 END) FROM creator_deal_payouts), 0)::text AS creator_wd_amount,
      -- Count of DISTINCT withdrawal requests that cashed out ≥1 deal-payout
      -- voucher in the period (one request can bundle several vouchers).
      (SELECT COUNT(DISTINCT request_id) FROM creator_deal_payouts WHERE effective_at >= ${cutoff})::text AS creator_wd_count,

      COALESCE(SUM(CASE WHEN type::text IN ${wagerTypesIn} AND created_at >= ${cutoff} THEN amount ELSE 0 END), 0)::text AS wager,

      -- Customer wager — the wager set MINUS wagers a creator made
      -- while live on a deal/stream (in_session). Creators wager
      -- house-funded "sponsored" balance on stream — recorded as
      -- ordinary pack_opening/battle_bet rows — which is not a real
      -- customer bet. A creator's OFF-session personal play stays in.
      COALESCE(SUM(CASE WHEN type::text IN ${wagerTypesIn} AND NOT in_session AND created_at >= ${cutoff} THEN amount ELSE 0 END), 0)::text AS wager_excl_session,

      -- Packs / Battles split of the customer GAMEPLAY wager. Same
      -- NOT in_session filter as wager_excl_session, so the two sum
      -- to it. Drives the "Where the wager comes from" chip row under
      -- the Total Wager card. Upgrader is added on top by the caller
      -- from upgrader_games (it is not a ledger wager source).
      COALESCE(SUM(CASE WHEN type::text = 'pack_opening' AND NOT in_session AND created_at >= ${cutoff} THEN amount ELSE 0 END), 0)::text AS pack_wager_excl_session,
      COALESCE(SUM(CASE WHEN type::text IN ('battle_bet','battle_sponsorship') AND NOT in_session AND created_at >= ${cutoff} THEN amount ELSE 0 END), 0)::text AS battle_wager_excl_session,

      -- Organic wager — pack / battle gameplay wager from users who
      -- did NOT join under an official creator code (and isn't a
      -- creator's own on-stream play, via NOT in_session). Reads off
      -- the under_creator flag set on the real_users CTE above.
      COALESCE(SUM(CASE WHEN type::text IN ${wagerTypesIn} AND NOT in_session AND NOT under_creator AND created_at >= ${cutoff} THEN amount ELSE 0 END), 0)::text AS wager_organic,

      -- NOTE: GGR is intentionally NOT computed here anymore. It is
      -- produced by the canonical @/lib/metrics inventory-delta
      -- definition (getWindowMetrics) in dashboardStatsInner. The
      -- previous inline wager minus 19-type payout aggregate folded the
      -- NEUTRAL card/voucher conversions and a phantom ledger
      -- upgrader_payout into the payout side; both are removed.

      -- Deposit COUNT — number of completed deposit transactions in
      -- the selected period. Pairs with revenue so the Deposits
      -- card can show "$X across N deposits".
      COUNT(CASE WHEN type::text = 'deposit' AND created_at >= ${cutoff} THEN 1 END)::text AS deposit_count,

      -- Windowed balance-change + manual-withdrawal sums for the
      -- windowed P&L figure (was 24h-only, now scoped to the selected
      -- period via the same cutoff). The base CTE is already filtered
      -- to staff+blacklist exclusion and status='completed', so these
      -- are free aggregates off the same scan. balance_after −
      -- balance_before carries the signed delta on every completed
      -- row, so summing across the window gives Δbalance directly.
      COALESCE(SUM(CASE
        WHEN created_at >= ${cutoff}
             -- FAKE-BALANCE carve-out: drop official_stream adjustments from
             -- the balance-delta term (owner-designated fake balance; mirrors
             -- calculateWindowedPnl / getDailyPnl).
             AND NOT (${Prisma.raw(officialStreamAdjustmentSqlPredicate({ metadataColumn: "lt_metadata" }))})
        THEN (lt_balance_after - lt_balance_before)::numeric ELSE 0 END), 0)::text AS balance_change,
      COALESCE(SUM(CASE
        WHEN type::text = 'admin_balance_adjustment'
             AND lt_description ILIKE 'Manual withdrawal:%'
             AND lt_balance_after < lt_balance_before
             AND created_at >= ${cutoff}
        THEN amount ELSE 0 END), 0)::text AS manual_wd
    FROM base
  `;
}

// Lifetime realized P&L lives in src/lib/queries/_realized-pnl.ts so the
// Analytics page can use the exact same definition. Do not inline it here.

// ============================================================
// Cross-request cached lifetime queries (5-minute TTL).
//
// The user's mental model after the perf pass:
//   • Wager + period P&L refresh every 60s (auto-refresh tick)
//   • Everything else refreshes every 5 minutes
//
// The "everything else" bucket is the slow lifetime stuff: 30-day
// daily series, lifetime depositor counts, FTDs, signups, etc. None
// of these move meaningfully minute-to-minute, so capping them at
// 5-minute staleness with `unstable_cache` means the 60s refresh
// hits cache for the heavy scans and only re-executes the wager/
// period stuff. Each helper takes its dynamic input as serializable
// arguments so the cache key reflects the blacklist (admin-managed
// /system/excluded-users page) and re-fetches when it changes.
// ============================================================

const cachedDailyChart = unstable_cache(
  async (blacklistIdNotIn: string) => {
    const db = await getDb();
    // GAMEPLAY wager (packs + battles) + deposits per day, last 30 days,
    // from the ledger. Upgrader is NOT here — it lives only in
    // `upgrader_games` (see `cachedDailyUpgrader`); the phantom
    // `upgrader_bet` ledger member doesn't exist on a migration-lagged DB
    // and threw `22P02`. The daily upgrader series is merged in by the
    // caller from the upgrader-native table.
    return db.$queryRaw<{
      date: Date;
      packs: string;
      battles: string;
      deposits: string;
      active_depositors: string;
    }[]>`
      SELECT
        DATE(created_at) as date,
        COALESCE(SUM(CASE WHEN type::text = 'pack_opening' THEN ABS(amount::numeric) ELSE 0 END), 0)::text as packs,
        COALESCE(SUM(CASE WHEN type::text IN ('battle_bet','battle_sponsorship') THEN ABS(amount::numeric) ELSE 0 END), 0)::text as battles,
        COALESCE(SUM(CASE WHEN type::text = 'deposit' THEN amount::numeric ELSE 0 END), 0)::text as deposits,
        COUNT(DISTINCT CASE WHEN type::text = 'deposit' THEN user_id END)::text as active_depositors
      FROM ledger_transactions
      WHERE type::text IN ('pack_opening','battle_bet','battle_sponsorship','deposit') AND status = 'completed'
        AND created_at >= NOW() - INTERVAL '30 days'
        AND user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin', 'support') ${Prisma.raw(blacklistIdNotIn)})
      GROUP BY DATE(created_at)
      ORDER BY date
    `;
  },
  ["dashboard-daily-chart-v2"],
  { revalidate: 300, tags: ["dashboard-lifetime"] },
);

/**
 * Daily upgrader wager (`upgrader_games.bet_amount`) per day for the last
 * 30 days — the upgrader-native companion to `cachedDailyChart` (which no
 * longer reads the phantom `upgrader_bet` ledger member). Merged into the
 * `dailyWagers` series by date so the Wagers chart's Upgrader segment is
 * sourced from the SAME table the dedicated Upgrader Stats panel uses.
 *
 * Guarded by a `to_regclass` probe — returns an empty series when the
 * connected DB has no `upgrader_games` table (the pre-upgrader snapshot),
 * a graceful skip rather than a `42P01` throw (same pattern as the
 * canonical `upgraderMetrics`). Real-customer scope mirrors the canonical
 * layer (admin / support / creator + blacklist dropped).
 */
const cachedDailyUpgrader = unstable_cache(
  async (blacklistIdNotIn: string): Promise<{ date: Date; upgrader: string }[]> => {
    const db = await getDb();
    const probe = await db.$queryRaw<{ exists: string | null }[]>`
      SELECT to_regclass('public.upgrader_games')::text AS exists`;
    if (probe[0]?.exists == null) return [];
    return db.$queryRaw<{ date: Date; upgrader: string }[]>`
      SELECT
        DATE(created_at) as date,
        COALESCE(SUM(bet_amount::numeric), 0)::text as upgrader
      FROM upgrader_games
      WHERE created_at >= NOW() - INTERVAL '30 days'
        AND user_id IN (
          SELECT id FROM "user"
          WHERE role NOT IN ('admin', 'support', 'creator') ${Prisma.raw(blacklistIdNotIn)}
        )
      GROUP BY DATE(created_at)
      ORDER BY date
    `;
  },
  ["dashboard-daily-upgrader-v1"],
  { revalidate: 300, tags: ["dashboard-lifetime"] },
);

const cachedDailySignups = unstable_cache(
  async (blacklistIdNotIn: string) => {
    const db = await getDb();
    return db.$queryRaw<{ date: Date; count: string }[]>`
      SELECT DATE(created_at) as date, COUNT(*)::text as count
      FROM "user"
      WHERE created_at >= NOW() - INTERVAL '30 days'
        AND role NOT IN ('admin', 'support') ${Prisma.raw(blacklistIdNotIn)}
      GROUP BY DATE(created_at)
      ORDER BY date
    `;
  },
  ["dashboard-daily-signups-v1"],
  { revalidate: 300, tags: ["dashboard-lifetime"] },
);

const cachedDailyWagerAttribution = unstable_cache(
  async (blacklistIdNotIn: string) => {
    const db = await getDb();
    return db.$queryRaw<{
      date: Date;
      organic: string;
      creator_attributed: string;
    }[]>`
      WITH customers AS (
        SELECT u.id,
               EXISTS (
                 SELECT 1 FROM "user" ref
                 WHERE ref.id = u.referred_by AND ref.role = 'creator'
               ) AS under_creator
        FROM "user" u
        WHERE u.role NOT IN ('admin', 'support', 'creator') ${Prisma.raw(blacklistIdNotIn)}
      )
      SELECT
        DATE(lt.created_at) AS date,
        COALESCE(SUM(CASE WHEN NOT c.under_creator THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS organic,
        COALESCE(SUM(CASE WHEN c.under_creator     THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS creator_attributed
      FROM ledger_transactions lt
      JOIN customers c ON c.id = lt.user_id
      WHERE lt.status = 'completed'
        -- Canonical ledger WAGER_TYPES only (packs + battles + sponsorship).
        -- Upgrader is NOT a ledger type (it lives in upgrader_games), so
        -- the phantom upgrader_bet member is gone -- referencing it threw
        -- 22P02 on a DB whose enum lacks it, and it never matched a row
        -- anyway. Upgrader is intentionally absent from this attribution
        -- split (it cannot be keyed to a creator-code referral), matching
        -- the Total Wager card organic figure (wagersOrganic).
        AND lt.type::text IN ('pack_opening','battle_bet','battle_sponsorship')
        AND lt.created_at >= NOW() - INTERVAL '30 days'
      GROUP BY DATE(lt.created_at)
      ORDER BY date
    `;
  },
  ["dashboard-daily-wager-attribution-v1"],
  { revalidate: 300, tags: ["dashboard-lifetime"] },
);

const cachedFtdCombined = unstable_cache(
  async (blacklistIdNotIn: string) => {
    const db = await getDb();
    return db.$queryRaw<{
      tag: string;
      bucket: Date | null;
      count: string;
      total: string;
    }[]>`
      WITH first_deposits AS (
        SELECT DISTINCT ON (user_id)
          user_id, amount::numeric AS amount, created_at
        FROM ledger_transactions
        WHERE type::text = 'deposit' AND status = 'completed'
          AND user_id IN (
            SELECT id FROM "user"
            WHERE role NOT IN ('admin', 'support') ${Prisma.raw(blacklistIdNotIn)}
          )
        ORDER BY user_id, created_at ASC
      )
      SELECT 'rolling24h'::text AS tag,
             NULL::date AS bucket,
             COUNT(*)::text AS count,
             COALESCE(SUM(amount), 0)::text AS total
      FROM first_deposits
      WHERE created_at >= NOW() - INTERVAL '24 hours'
      UNION ALL
      SELECT 'daily'::text AS tag,
             DATE(created_at) AS bucket,
             COUNT(*)::text AS count,
             COALESCE(SUM(amount), 0)::text AS total
      FROM first_deposits
      WHERE created_at >= NOW() - INTERVAL '30 days'
      GROUP BY DATE(created_at)
    `;
  },
  ["dashboard-ftd-combined-v1"],
  { revalidate: 300, tags: ["dashboard-lifetime"] },
);

const cachedLifetimeDepositMetrics = unstable_cache(
  async (blacklistIdNotIn: string) => {
    const db = await getDb();
    return db.$queryRaw<{
      lifetime: string;
      h24: string;
      d7: string;
    }[]>`
      SELECT
        COUNT(*)::text AS lifetime,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')::text AS h24,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::text AS d7
      FROM ledger_transactions
      WHERE type::text = 'deposit'
        AND status = 'completed'
        AND user_id IN (
          SELECT id FROM "user"
          WHERE role NOT IN ('admin', 'support') ${Prisma.raw(blacklistIdNotIn)}
        )
    `;
  },
  ["dashboard-lifetime-deposit-metrics-v1"],
  { revalidate: 300, tags: ["dashboard-lifetime"] },
);

// ============================================================
// Caches added in the 2026-05-30 perf pass.
//
// `balanceAggregates`, `uniqueDepositors`, `packsOpened24h`,
// `battlesPlayed24h` were the only uncached lifetime / 24h
// rolling queries left in the dashboard. The first two scan the
// entire `balances` table; the second two are smaller counts
// but still ran on every 60s auto-refresh. Each is wrapped here
// with a TTL appropriate for how fast the underlying number
// actually moves (5 min for lifetime aggregates, 60s for the
// rolling-24h counts so they stay close to live without
// hammering the DB on every refresh).
// ============================================================

const cachedBalanceAggregates = unstable_cache(
  async (blacklistIdNotIn: string) => {
    const db = await getDb();
    // Raw SQL instead of Prisma's `db.balances.aggregate` because
    // the unstable_cache key argument must be serializable —
    // passing the Prisma `where` object would either fail (the
    // staffRelation contains Prisma helpers) or hash to a string
    // that drifts when the helper rebuilds. The raw query takes
    // the blacklist string fragment directly.
    const rows = await db.$queryRaw<
      {
        total_deposited: string;
        total_withdrawn: string;
        total_wagered: string;
        total_won: string;
        available_balance: string;
      }[]
    >`
      SELECT
        COALESCE(SUM(total_deposited::numeric), 0)::text AS total_deposited,
        COALESCE(SUM(total_withdrawn::numeric), 0)::text AS total_withdrawn,
        COALESCE(SUM(total_wagered::numeric), 0)::text AS total_wagered,
        COALESCE(SUM(total_won::numeric), 0)::text AS total_won,
        -- FAKE-BALANCE: net the signed official_stream credit out of the
        -- aggregated available balance so this displayed figure matches the
        -- realized-P&L treatment (_realized-pnl.ts nets the same sum from
        -- userBalance). Subtracts the Σ signed amount of completed
        -- official_stream adjustments over the SAME real-user population.
        (COALESCE(SUM(available_balance::numeric), 0)
         - COALESCE((
             SELECT SUM(lt.amount::numeric)
             FROM ledger_transactions lt
             WHERE lt.status = 'completed'
               AND ${Prisma.raw(officialStreamAdjustmentSqlPredicate({ typeColumn: "lt.type", metadataColumn: "lt.metadata" }))}
               AND lt.user_id IN (
                 SELECT id FROM "user"
                 WHERE role NOT IN ('admin', 'support') ${Prisma.raw(blacklistIdNotIn)}
               )
           ), 0)
        )::text AS available_balance
      FROM balances
      WHERE user_id IN (
        SELECT id FROM "user"
        WHERE role NOT IN ('admin', 'support') ${Prisma.raw(blacklistIdNotIn)}
      )
    `;
    return rows[0] ?? null;
  },
  ["dashboard-balance-aggregates-v1"],
  { revalidate: 300, tags: ["dashboard-lifetime"] },
);

const cachedUniqueDepositors = unstable_cache(
  async (blacklistIdNotIn: string) => {
    const db = await getDb();
    const rows = await db.$queryRaw<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM balances
      WHERE total_deposited::numeric > 0
        AND user_id IN (
          SELECT id FROM "user"
          WHERE role NOT IN ('admin', 'support') ${Prisma.raw(blacklistIdNotIn)}
        )
    `;
    return Number(rows[0]?.count ?? 0);
  },
  ["dashboard-unique-depositors-v1"],
  { revalidate: 300, tags: ["dashboard-lifetime"] },
);

const cached24hPackOpens = unstable_cache(
  async (blacklistIdNotIn: string) => {
    const db = await getDb();
    const rows = await db.$queryRaw<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM game_sessions
      WHERE game_type = 'pack'
        AND created_at >= NOW() - INTERVAL '24 hours'
        AND user_id IN (
          SELECT id FROM "user"
          WHERE role NOT IN ('admin', 'support') ${Prisma.raw(blacklistIdNotIn)}
        )
    `;
    return Number(rows[0]?.count ?? 0);
  },
  ["dashboard-packs-opened-24h-v1"],
  { revalidate: 60, tags: ["dashboard-activity"] },
);

const cached24hBattles = unstable_cache(
  async (blacklistIdNotIn: string) => {
    const db = await getDb();
    const rows = await db.$queryRaw<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM battles
      WHERE created_at >= NOW() - INTERVAL '24 hours'
        AND user_id IN (
          SELECT id FROM "user"
          WHERE role NOT IN ('admin', 'support') ${Prisma.raw(blacklistIdNotIn)}
        )
    `;
    return Number(rows[0]?.count ?? 0);
  },
  ["dashboard-battles-played-24h-v1"],
  { revalidate: 60, tags: ["dashboard-activity"] },
);

const cachedUserCounts = unstable_cache(
  async (
    blacklistIdNotIn: string,
    startOfDayIso: string,
    startOfWeekIso: string,
    startOfMonthIso: string,
  ) => {
    const db = await getDb();
    // Re-hydrate the ISO strings into Date objects on the SQL side so
    // Prisma binds them as timestamps. rolling24h is recomputed from
    // `now` here too — the cache TTL (5 min) bounds how stale this
    // number can get, so the slight rounding error is acceptable.
    const startOfDay = new Date(startOfDayIso);
    const startOfWeek = new Date(startOfWeekIso);
    const startOfMonth = new Date(startOfMonthIso);
    const rolling24h = new Date(Date.now() - 1 * MS_PER_DAY);
    return db.$queryRaw<{
      total: string;
      today: string;
      week: string;
      month: string;
      rolling24h: string;
    }[]>`
      SELECT
        COUNT(*)::text AS total,
        COUNT(*) FILTER (WHERE created_at >= ${startOfDay})::text AS today,
        COUNT(*) FILTER (WHERE created_at >= ${startOfWeek})::text AS week,
        COUNT(*) FILTER (WHERE created_at >= ${startOfMonth})::text AS month,
        COUNT(*) FILTER (WHERE created_at >= ${rolling24h})::text AS rolling24h
      FROM "user"
      WHERE role NOT IN ('admin', 'support') ${Prisma.raw(blacklistIdNotIn)}
    `;
  },
  ["dashboard-user-counts-v1"],
  { revalidate: 300, tags: ["dashboard-lifetime"] },
);

/**
 * Rolling-24h activity counts only: signups, packs opened, battles played.
 *
 * Exposed as a public function so the docked Recent Activity widget — which
 * lives in the admin shell on every page, not just `/dashboard` — can power
 * its count strip without pulling the full `getDashboardStats` aggregate
 * (which scans ~20 ledger / balance / FTD queries the widget doesn't need).
 *
 * Reuses the SAME three caches the dashboard hits (`cachedUserCounts`,
 * `cached24hPackOpens`, `cached24hBattles`) so the widget piggy-backs on the
 * dashboard's 60s / 5min cache windows — zero extra DB pressure once warm,
 * and the values match what the dashboard renders at the same instant.
 *
 * Staff + blacklisted users are excluded (same filter the dashboard uses).
 */
export async function getActivityCounts24h(): Promise<{
  signups24h: number;
  packsOpened24h: number;
  battlesPlayed24h: number;
}> {
  const blacklistIdNotIn = blacklistNotInClause(
    "id",
    await getExcludedUserIds(),
  );
  // Start-of-day/week/month aren't read here (the widget only needs the
  // rolling-24h signup count) but cachedUserCounts takes them as part of
  // its cache key, so we pass deterministic values. Re-using the same
  // computed start-of-day the dashboard uses keeps the cache key
  // identical so this call dedupes against the dashboard's call within
  // the 5-min TTL window.
  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setUTCHours(0, 0, 0, 0);
  const startOfWeek = new Date(startOfDay);
  startOfWeek.setUTCDate(startOfDay.getUTCDate() - startOfDay.getUTCDay());
  const startOfMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  );

  const [userCounts, packsOpened24h, battlesPlayed24h] = await Promise.all([
    cachedUserCounts(
      blacklistIdNotIn,
      startOfDay.toISOString(),
      startOfWeek.toISOString(),
      startOfMonth.toISOString(),
    ),
    cached24hPackOpens(blacklistIdNotIn),
    cached24hBattles(blacklistIdNotIn),
  ]);
  return {
    signups24h: Number(userCounts[0]?.rolling24h ?? 0),
    packsOpened24h,
    battlesPlayed24h,
  };
}

/**
 * Dedicated 30-min (`revalidate: 1800`) cache for the admin top-bar house
 * pills. ONE indexed query returns all four lifetime totals so the pills
 * read a single cached value on every admin page.
 *
 * WHY ITS OWN CACHE (not the dashboard's 5-min `cachedBalanceAggregates`):
 *   1. The owner wants the pills cached for 30 minutes — "load it once when
 *      you enter the site and then refetch all 30 min; even on reload don't
 *      fetch it instantly." `unstable_cache` is a SHARED server cache, so a
 *      page reload / new request inside the 30-min window serves the cached
 *      value with no DB hit — exactly that behaviour. The dashboard's own
 *      aggregate stays on its 5-min TTL (its numbers move faster), so the
 *      two caches don't fight.
 *   2. The withdrawal total here is NOT `balances.total_withdrawn` (that
 *      column under-counts — it misses the entire `card_withdrawal_requests`
 *      pipeline, which is why the pill read ~$1K). It is the AUTHORITATIVE
 *      site-wide "money out" figure: Σ `card_withdrawal_requests.total_value_usd`
 *      where `status IN ('completed','shipped')`, real users only. This is
 *      the SAME source the dashboard's "Withdrawals" StatCard and the
 *      Analytics → Revenue withdrawal breakdown use, so the pill reconciles
 *      with both. (Indexed by `idx_cwr_status_completed_at`, so it stays a
 *      cheap scan even on the cold miss.)
 *
 * The other three legs come from the `balances` table — the SAME columns the
 * lifetime realized-P&L snapshot trusts (`_realized-pnl.ts`:
 * `Σ total_deposited`, and the dashboard financials block reads
 * `total_wagered` / `total_won`), so deposits / wager / GGR reconcile with
 * the dashboard's lifetime figures.
 *
 * The cache key is the serialized blacklist clause (same key shape the
 * dashboard's cached aggregates use) so an excluded-user change becomes
 * visible within the TTL.
 */
const cachedLifetimeHouseTotals = unstable_cache(
  async (blacklistIdNotIn: string) => {
    const db = await getDb();
    // Single round-trip: the three `balances` accumulators in one scan,
    // plus the authoritative card-withdrawal "money out" total as a
    // correlated subquery. Both are filtered to the same real-user
    // population (role NOT IN ('admin','support') + blacklist). Raw SQL
    // (not Prisma aggregate) so the cache-key argument stays a plain
    // serializable string — same reason as `cachedBalanceAggregates`.
    const rows = await db.$queryRaw<
      {
        total_deposited: string;
        total_wagered: string;
        // Organic wager — Σ balances.total_wagered restricted to users who
        // did NOT join under an official creator code (referred_by does not
        // point to a role='creator' user). Drives the top-bar "Organic
        // Wager" pill. Reuses the SAME organic attribution rule as the
        // dashboard's Organic Wager KPI card (the `under_creator` flag in
        // getPeriodAggregates): a user is creator-attributed iff their
        // referred_by resolves to a creator. This is a separate figure from
        // `total_wagered` — GGR below still uses the FULL total_wagered.
        organic_wagered: string;
        total_won: string;
        card_withdrawn: string;
      }[]
    >`
      SELECT
        COALESCE((
          SELECT SUM(total_deposited::numeric) FROM balances
          WHERE user_id IN (
            SELECT id FROM "user"
            WHERE role NOT IN ('admin', 'support') ${Prisma.raw(blacklistIdNotIn)}
          )
        ), 0)::text AS total_deposited,
        COALESCE((
          SELECT SUM(total_wagered::numeric) FROM balances
          WHERE user_id IN (
            SELECT id FROM "user"
            WHERE role NOT IN ('admin', 'support') ${Prisma.raw(blacklistIdNotIn)}
          )
        ), 0)::text AS total_wagered,
        -- Organic wager: same real-user population MINUS users who joined
        -- under an official creator code. under_creator = referred_by
        -- resolves to a role=creator user (NULL referred_by => organic) --
        -- the SAME attribution rule as the dashboard Organic Wager KPI card.
        -- Structured as a user_id IN (SELECT id FROM "user" ...) subquery
        -- (mirroring the other legs above) so the SAME blacklistIdNotIn
        -- (column id) drops in verbatim with no aliasing, and it stays a
        -- single indexed aggregate on balances. Behind the 30-min cache, so
        -- the extra creator-attribution filter is paid at most once/window.
        COALESCE((
          SELECT SUM(total_wagered::numeric) FROM balances
          WHERE user_id IN (
            SELECT id FROM "user"
            WHERE role NOT IN ('admin', 'support') ${Prisma.raw(blacklistIdNotIn)}
              AND NOT EXISTS (
                SELECT 1 FROM "user" ref
                WHERE ref.id = "user".referred_by AND ref.role = 'creator'
              )
          )
        ), 0)::text AS organic_wagered,
        COALESCE((
          SELECT SUM(total_won::numeric) FROM balances
          WHERE user_id IN (
            SELECT id FROM "user"
            WHERE role NOT IN ('admin', 'support') ${Prisma.raw(blacklistIdNotIn)}
          )
        ), 0)::text AS total_won,
        -- AUTHORITATIVE all-time withdrawals: card_withdrawal_requests
        -- (status IN completed/shipped) — value that actually left the
        -- house. Matches the dashboard's Withdrawals StatCard + the
        -- Analytics Revenue withdrawal breakdown. NOT balances.total_withdrawn,
        -- which under-counts (misses this pipeline).
        COALESCE((
          SELECT SUM(cwr.total_value_usd::numeric)
          FROM card_withdrawal_requests cwr
          WHERE cwr.status IN ('completed', 'shipped')
            AND cwr.user_id IN (
              SELECT id FROM "user"
              WHERE role NOT IN ('admin', 'support') ${Prisma.raw(blacklistIdNotIn)}
            )
        ), 0)::text AS card_withdrawn
    `;
    return rows[0] ?? null;
  },
  ["dashboard-lifetime-house-totals-v1"],
  // 30-min TTL per the owner's ask — these all-time figures barely move,
  // and the pills should "load once on entry, refetch every 30 min, and
  // not refetch instantly on reload". A 30-min shared-cache window does
  // exactly that.
  { revalidate: 1800, tags: ["dashboard-lifetime"] },
);

/**
 * Lifetime house headline totals (all-time wager / deposit / withdrawal +
 * gaming margin) for the admin top-bar pills.
 *
 * Reads a SINGLE 30-min-cached row (`cachedLifetimeHouseTotals`) so the
 * pills — which render on EVERY admin page — never trigger a per-request
 * scan. A reload / new request inside the 30-min window serves the cached
 * value with no DB hit (the owner's "don't refetch instantly on reload"
 * requirement). A cold miss costs one indexed aggregate, capped at one per
 * 30 minutes across all admins.
 *
 * If the cached row is unavailable the fields come back as 0 (the caller
 * wraps the call in `safeQuery` + `<Suspense>` so a slow/failed read
 * degrades to "—" pills instead of blocking the shell).
 *
 * Sources (all reconcile with the dashboard's lifetime figures):
 *   • wager       = Σ balances.total_wagered for ORGANIC users only — users
 *                   who did NOT join under an official creator code
 *                   (referred_by does not resolve to a role='creator' user).
 *                   This is the "Organic Wager" pill: it excludes wager that
 *                   is downstream of creator marketing, reusing the SAME
 *                   organic-attribution rule as the dashboard's Organic Wager
 *                   KPI card. (The FULL total_wagered still backs GGR below —
 *                   GGR is a house-margin figure and must net against the
 *                   full wagered/won pair, not the organic slice.)
 *   • deposits    = Σ balances.total_deposited
 *   • withdrawals = Σ card_withdrawal_requests.total_value_usd
 *                   (status IN completed/shipped) — the AUTHORITATIVE
 *                   site-wide "money out" total (same source as the
 *                   dashboard Withdrawals StatCard + Analytics Revenue tab),
 *                   NOT balances.total_withdrawn (which under-counts).
 *   • ggr         = (FULL) Σ balances.total_wagered − Σ balances.total_won
 *                   (house gaming margin, house POV: positive = house up).
 *                   Uses the FULL wager, NOT the organic pill figure.
 *
 * Staff + blacklisted users are excluded (same filter the dashboard uses),
 * so the figures match the dashboard's lifetime aggregates.
 */
export async function getLifetimeHouseTotals(): Promise<{
  wager: number;
  deposits: number;
  withdrawals: number;
  ggr: number;
}> {
  const blacklistIdNotIn = blacklistNotInClause(
    "id",
    await getExcludedUserIds(),
  );
  const row = await cachedLifetimeHouseTotals(blacklistIdNotIn);
  // The pill shows ORGANIC wager (creator-code users dropped). GGR still
  // uses the FULL total_wagered so the gaming margin nets the whole
  // wagered/won pair — both legs come from the same cached row.
  const totalWager = toNumber(row?.total_wagered);
  const organicWager = toNumber(row?.organic_wagered);
  const deposits = toNumber(row?.total_deposited);
  const withdrawals = toNumber(row?.card_withdrawn);
  const won = toNumber(row?.total_won);
  return {
    wager: organicWager,
    deposits,
    withdrawals,
    // House gaming margin (GGR) = FULL total staked − total paid out in
    // wins. Uses the full wager (not the organic pill figure) so the margin
    // is the true house gaming result; both legs are from the same row.
    ggr: totalWager - won,
  };
}

/**
 * Per-request memoized. The dashboard page streams several independent
 * Suspense segments (KPI strips, charts, the activity count strip) that
 * each read these stats; `cache()` ensures the heavy aggregate runs
 * once per render, not once per segment. Keyed on `period`, so flipping
 * the global selector triggers a re-fetch but only the period-bound
 * scans within a single render dedupe. Cross-request caching is
 * intentionally omitted — these are live platform numbers and the page
 * already revalidates them via the 60s AutoRefresh.
 */
export const getDashboardStats = cache(async (period: DashboardPeriod = DEFAULT_DASHBOARD_PERIOD) => {
  return withTiming("dashboard.getDashboardStats", () => dashboardStatsInner(period));
});

async function dashboardStatsInner(period: DashboardPeriod) {
  // Wall-clock start of the server-side compute. Returned as `queryMs`
  // (Date.now() − t0 just before the return) so the dashboard can show a
  // real "Loaded in N ms" indicator instead of a faked/animated one. This
  // measures the whole aggregate (exclusion-list resolution + the parallel
  // query batch + post-processing), which is exactly the latency an admin
  // perceives when the streamed KPI strips resolve.
  const t0 = Date.now();
  const db = await getDb();
  // Resolve the combined staff+blacklist filter ONCE per request so
  // every aggregate below applies the same exclusion set. The list is
  // cached via React `cache()` in fetch.ts → repeated invocations are
  // free.
  const [staffRelation, excluded, sessionWindowsCte] = await Promise.all([
    excludeStaffAndBlacklisted(),
    getExcludedUserIds(),
    // Creator deal/stream session windows (backend creators API;
    // 5-min cached, best-effort) — drives the customer-wager
    // exclusion in getPeriodAggregates.
    getCreatorSessionWindowsCte(),
  ]);
  // Inline SQL fragment for `AND id NOT IN (...)` for the raw queries
  // that already do role NOT IN ('admin','support'). Empty string when
  // nothing is blacklisted so the query stays valid.
  const blacklistIdNotIn = blacklistNotInClause("id", excluded);
  const now = new Date();
  // UTC-anchored boundaries so the dashboard renders the same numbers no
  // matter which timezone the request happens to land in (Vercel functions
  // can run in any region). Mirrors the convention used by
  // src/lib/queries/_realized-pnl.ts and src/lib/balance-limits.ts.
  const startOfDay = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const startOfWeek = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - now.getUTCDay(),
    ),
  );
  const startOfMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  );

  // rolling24h drives the 24h Activity tile (pack openings + battles
  // count) — the FTD / depositMetrics queries are now in cached helpers
  // that compute their own rolling cutoffs inside the cached fn.
  const rolling24h = new Date(now.getTime() - 1 * MS_PER_DAY);
  // Cutoff for the SELECTED period — drives every period-bound query
  // (periodAggregates, windowed inventory/voucher delta, etc.). One
  // value, one set of indexed scans — the whole point of the global
  // selector. `new Date(0)` for "all" lets the cutoff filter degrade
  // to a no-op without a special SQL branch.
  const periodCutoff = periodToCutoff(period, now);
  // Canonical metric window for the selected period — `since: null` for
  // "all" (true lifetime), else the rolling cutoff. Drives the
  // `@/lib/metrics` GGR + upgrader reads, which bake in the central
  // real-customer + borrow-corrected scope (so the session-window /
  // scope fixes landing in `@/lib/metrics` propagate here automatically).
  const metricWindow = periodToMetricWindow(period, now);

  // Perf audit (2026-05-27): cut the dashboard's parallel query batch
  // from 17 to 12 queries, and dropped the 4-query
  // calculateWindowedPnl() call for the 24h P&L. Net is roughly 9
  // fewer round-trips per dashboard refresh.
  // Dropped queries (the fields they fed were never read by the UI):
  //   • packStats         — stats.packs.* unused
  //   • activityTotals    — totalPacksOpened / totalBattlesPlayed unused
  //   • pendingWithdrawals — operations.* unused
  //   • active_users_24h column in periodAggregates — unused
  // Merges (same plan, fewer round-trips):
  //   • signups24h folded into userCounts (one user-table scan via
  //     FILTER blocks, same as today/week/month)
  //   • ftdResult (24h) + dailyFtds → one UNION ALL on a shared
  //     first_deposits CTE, so the lifetime DISTINCT ON scan runs once
  //   • dailyActiveDepositors folded into the dailyChart 30-day scan
  //     (same ledger rows, extra COUNT DISTINCT column)
  // Replacement of calculateWindowedPnl(24h):
  //   • The 24h components come from the existing periodAggregates
  //     query (revenue_24h, withdrawal_24h, balance_change_24h,
  //     manual_wd_24h) PLUS a single composite query for the 24h
  //     inventory + voucher deltas. Saves 2 ledger scans and 2
  //     parallel round-trips.
  const [
    userCounts,
    balanceAggregates,
    dailyChart,
    dailyUpgrader,
    dailySignups,
    dailyWagerAttribution,
    periodAggregates,
    windowMetricsResult,
    upgraderWindow,
    uniqueDepositorsResult,
    realizedPnlResult,
    packsOpened24h,
    battlesPlayed24h,
    ftdCombined,
    windowedPeriodDelta,
    lifetimeDepositMetrics,
  ] = await Promise.all([
    // Per-sub-query timings — wraps each Promise.all entry with
    // `withTiming("dashboard.<name>")` so /system/stats can pinpoint
    // exactly which sub-query is dragging the dashboard latency. The
    // top-level `dashboard.getDashboardStats` wraps the whole batch,
    // so cross-checking individual entries against that total tells
    // operators whether the slow component is one heavy query (single
    // entry > 60-70% of the total) or many medium queries adding up.

    // All four user counts (total + today/week/month) PLUS the
    // rolling-24h signup count in ONE scan of the user table via
    // COUNT(*) FILTER. 5-min cached — user counts don't move by more
    // than a handful per minute, so the 5-min cap is invisible.
    withTiming("dashboard.userCounts", () =>
      cachedUserCounts(
        blacklistIdNotIn,
        startOfDay.toISOString(),
        startOfWeek.toISOString(),
        startOfMonth.toISOString(),
      ),
    ),
    // Single balances aggregate — `available_balance` is folded in with
    // the lifetime _sums so the dashboard pays one round-trip, not two.
    // 5-min cross-request cached — these are lifetime sums that move
    // by at most a few users per minute, so 5-min staleness is
    // invisible. Switched from Prisma's aggregate to raw SQL so the
    // blacklist string fragment can serve as a stable cache key.
    withTiming("dashboard.balanceAggregates", () =>
      cachedBalanceAggregates(blacklistIdNotIn),
    ),
    // Daily wager + deposit + active-depositor series for the last 30
    // days in ONE ledger scan. 5-min cached — historic days don't
    // change and today's row moves slowly enough that operators
    // wouldn't notice a 5-min lag.
    withTiming("dashboard.dailyChart", () => cachedDailyChart(blacklistIdNotIn)),
    // Daily upgrader wager (last 30 days) from `upgrader_games` — the
    // upgrader-native companion to the daily ledger scan above. Merged
    // into the dailyWagers series by date. Empty on a pre-upgrader DB
    // (to_regclass guard). 5-min cached.
    withTiming("dashboard.dailyUpgrader", () => cachedDailyUpgrader(blacklistIdNotIn)),
    // Signups last 30 days. 5-min cached for the same reason.
    withTiming("dashboard.dailySignups", () => cachedDailySignups(blacklistIdNotIn)),
    // Daily wager attribution split — organic (no creator-code
    // referral) vs creator-attributed. 5-min cached.
    withTiming("dashboard.dailyWagerAttribution", () =>
      cachedDailyWagerAttribution(blacklistIdNotIn),
    ),
    // Single batched query — computes revenue / withdrawal / wager /
    // deposit_count / balance_change / manual_wd for the SELECTED
    // period only. Previously this fanned out into 9 windows × many
    // metrics per render; now only the chip the admin clicked gets
    // computed, which is the headline perf win of the period selector.
    // Also produces `balance_change` and `manual_wd` so the windowed
    // P&L no longer needs a separate calculateWindowedPnl() call. GGR is
    // NO LONGER produced here — see `windowMetrics` below.
    // NOT cached — recomputes every render because the cutoff depends
    // on the selected period.
    withTiming("dashboard.periodAggregates", () =>
      getPeriodAggregates(db, periodCutoff, blacklistIdNotIn, sessionWindowsCte),
    ),
    // Canonical headline GGR (+ NGR / RTP / house-edge / bets) for the
    // selected window, from the `@/lib/metrics` inventory-delta
    // definition: wager (ledger WAGER_TYPES + upgrader bet) − (Σ
    // user_inventory win delta + |battle_refund| + upgrader payout), with
    // the central real-customer + borrow-corrected scope. Upgrader IS
    // folded into the gaming margin now — `getGamingLegs` sources both
    // its wager and payout from `upgrader_games` (a two-legged, correct
    // contribution), so the headline, the GGR breakdown popover and the
    // contributor sweep all include upgrader; the dedicated Upgrader
    // Stats panel still shows it standalone. Replaces the old inline
    // `wager − Σ payout(19)` aggregate.
    //
    // Now CACHED + BOUNDED + TIMEOUT-WRAPPED (it was none of these):
    //   • The "all" chip is capped to a bounded 365-day window
    //     (`periodToMetricWindow`) so this never runs an UNBOUNDED
    //     full-history scan of `ledger_transactions` / `user_inventory` /
    //     `upgrader_games` — the single biggest MAIN-pool risk this read
    //     carried (matches how `/ggr`'s Lifetime chip is capped).
    //   • `cachedWindowMetricsForPeriod` caches it period-keyed (300s for
    //     "all", 60s for rolling chips) so the dashboard's 60s
    //     auto-refresh hits cache for the heavy legs.
    //   • `safeQuery(..., REWARD_QUERY_TIMEOUT_MS)` (15s) bounds the wait
    //     on a cold-miss scan so a slow read degrades the headline tile to
    //     the all-zero fallback (`EMPTY_WINDOW_METRICS`) instead of
    //     hanging the entire KPI strip until the platform kills the
    //     request. `.data` is unwrapped at the read site below.
    withTiming("dashboard.windowMetrics", () =>
      safeQuery(
        () => cachedWindowMetricsForPeriod(period, blacklistIdNotIn),
        EMPTY_WINDOW_METRICS,
        "dashboard.windowMetrics",
        REWARD_QUERY_TIMEOUT_MS,
      ),
    ),
    // Upgrader gaming metrics for the selected window from
    // `upgrader_games` (canonical helper) — drives the Total Wager
    // card's Upgrader chip + breakdown. `null` on a pre-upgrader DB
    // (to_regclass guard). NOT cached — window-dependent.
    withTiming("dashboard.upgraderWindow", () => upgraderMetrics(metricWindow)),
    // Distinct depositors = real users whose LIFETIME completed-deposit
    // total is > 0. 5-min cached — lifetime depositor count moves
    // slower than 5 minutes.
    withTiming("dashboard.uniqueDepositors", () =>
      cachedUniqueDepositors(blacklistIdNotIn),
    ),
    // Lifetime realized P&L snapshot — single heaviest query in the
    // codebase. Cached cross-request 5 minutes via unstable_cache, so
    // most renders hit the cache and this timing is ~0. A cold cache
    // miss reveals the full scan duration.
    withTiming("dashboard.realizedPnlSnapshot", () => getRealizedPnlSnapshot()),
    // Rolling-24h pack opening count for the "24h Activity" tile.
    // 60s cached — matches the dashboard's auto-refresh cadence so the
    // tile stays close to live without re-counting on every render.
    withTiming("dashboard.packsOpened24h", () =>
      cached24hPackOpens(blacklistIdNotIn),
    ),
    // Rolling-24h battle count — 60s cached for the same reason.
    withTiming("dashboard.battlesPlayed24h", () =>
      cached24hBattles(blacklistIdNotIn),
    ),
    // FTDs combined — rolling-24h figure (count + total) + per-day
    // counts/totals for the last 30 days, sharing a single
    // first_deposits CTE. 5-min cached — first deposits don't change
    // that often, and FTD math involves a lifetime DISTINCT ON scan
    // which was one of the heavier queries on the hot path.
    withTiming("dashboard.ftdCombined", () => cachedFtdCombined(blacklistIdNotIn)),
    // Windowed inventory + voucher deltas for the SELECTED period.
    // The other three components of the period P&L (deposits, card-
    // withdrawals, ledger balance change, manual withdrawals) already
    // come from periodAggregates / the realized snapshot — these are
    // the two pieces it doesn't carry, so we fetch them in one
    // composite query. Each subselect is a narrow indexed range scan;
    // PG materializes the common `real_users` CTE once.
    withTiming("dashboard.windowedPeriodDelta", () =>
      db.$queryRaw<{
        inv_obtained: string;
        inv_disposed: string;
        vch_issued: string;
        vch_claimed: string;
      }[]>`
        WITH real_users AS (
          SELECT id FROM "user"
          WHERE role NOT IN ('admin', 'support') ${Prisma.raw(blacklistIdNotIn)}
        )
        SELECT
          COALESCE((SELECT SUM(value_at_obtained::numeric) FROM user_inventory
            WHERE obtained_at >= ${periodCutoff}
              AND user_id IN (SELECT id FROM real_users)), 0)::text AS inv_obtained,
          COALESCE((SELECT SUM(value_at_obtained::numeric) FROM user_inventory
            WHERE (sold_at >= ${periodCutoff} OR exchanged_at >= ${periodCutoff})
              AND user_id IN (SELECT id FROM real_users)), 0)::text AS inv_disposed,
          COALESCE((SELECT SUM(value::numeric) FROM vouchers
            WHERE created_at >= ${periodCutoff}
              AND user_id IN (SELECT id FROM real_users)), 0)::text AS vch_issued,
          COALESCE((SELECT SUM(value::numeric) FROM vouchers
            WHERE claimed_at >= ${periodCutoff}
              AND user_id IN (SELECT id FROM real_users)), 0)::text AS vch_claimed
      `,
    ),
    // Lifetime + 24h + 7d deposit transaction counts in one indexed
    // scan. 5-min cached. The rolling-24h / 7d cutoffs are recomputed
    // inside the cached fn from Date.now() — within the 5-min TTL
    // there's no meaningful drift.
    withTiming("dashboard.lifetimeDepositMetrics", () =>
      cachedLifetimeDepositMetrics(blacklistIdNotIn),
    ),
  ]);

  // Headline GGR/NGR — `safeQuery` returns `{ data, error }`. The headline
  // tile is a single number on the KPI strip, so a degraded read shows the
  // all-zero fallback (`EMPTY_WINDOW_METRICS`) inline rather than crashing
  // the strip; the error is already logged inside `safeQuery` with the
  // `dashboard.windowMetrics` context. Unwrapped to `.data` here so the
  // rest of this function reads the metrics object as before.
  const windowMetrics = windowMetricsResult.data;

  // balanceAggregates was switched to raw SQL so it could be wrapped
  // with unstable_cache (Prisma's `where` object isn't a stable cache
  // key). Field shape changed from `{ _sum: { total_wagered, ... } }`
  // to `{ total_wagered, ... }` with string numeric values — parse via
  // parseFloat at each read site.
  const ba = balanceAggregates ?? {
    total_deposited: "0",
    total_withdrawn: "0",
    total_wagered: "0",
    total_won: "0",
    available_balance: "0",
  };
  const totalWagered = parseFloat(ba.total_wagered) || 0;
  const totalWon = parseFloat(ba.total_won) || 0;

  // Unpack the batched period aggregates. Each field is a text-encoded
  // numeric; parseFloat() is sufficient because we're always going
  // through Number coercion anyway downstream. Each field is scoped to
  // the SELECTED period via `periodCutoff` — switching the global
  // period selector picks a new cutoff and re-runs this one query.
  const pa = periodAggregates[0] ?? {
    revenue: "0",
    withdrawal: "0",
    withdrawal_count: "0",
    wager: "0",
    wager_excl_session: "0",
    pack_wager_excl_session: "0",
    battle_wager_excl_session: "0",
    wager_organic: "0",
    deposit_count: "0",
    balance_change: "0",
    manual_wd: "0",
    creator_wd_amount: "0",
    creator_wd_count: "0",
  };
  const num = (s: string) => parseFloat(s) || 0;
  // Canonical upgrader wager for the window (from `upgrader_games` via
  // `upgraderMetrics`), or 0 on a pre-upgrader DB. Added to the customer
  // wager DISPLAY tiles as a first-class product line alongside the
  // ledger pack/battle wager. This is the SAME `upgraderMetrics` source
  // (same window) that `getGamingLegs` folds into the headline GGR's
  // wager leg, so the Total Wager card's Upgrader chip and the GGR
  // breakdown popover's Upgrader-wager row carry the identical figure.
  // The dedicated Upgrader Stats panel shows upgrader's own edge.
  const upgraderWagerPeriod = upgraderWindow?.wager ?? 0;
  // Lifetime deposit transaction count comes from
  // `lifetimeDepositMetrics` (a tiny indexed count, not the period
  // aggregate). Independent of the selected period so the Avg Deposit
  // / Depositors-derived math stays stable when the chip changes.
  const depMetrics = lifetimeDepositMetrics[0] ?? {
    lifetime: "0",
    h24: "0",
    d7: "0",
  };
  const depositCount = num(depMetrics.lifetime);
  // Deposit counts for the two fixed windows the "Deposits / hr" tile
  // uses. NOT period-bound (the tile's subtitle compares 24h to 7d
  // baseline, always — flipping the global selector shouldn't reshape
  // a tile labelled "last 24h avg").
  const depositCount24h = num(depMetrics.h24);
  const depositCount7d = num(depMetrics.d7);

  // FTD rows come back via UNION: one 'rolling24h' row (bucket = NULL)
  // and many 'daily' rows (bucket = a calendar date) — see the
  // ftdCombined query above. Splitting them out here keeps the two
  // downstream consumers (ftds24h tile + dailyFtds chart) clean.
  const ftdRolling = ftdCombined.find((r) => r.tag === "rolling24h");
  const ftdDailyRows = ftdCombined
    .filter((r) => r.tag === "daily" && r.bucket !== null)
    .sort((a, b) => {
      // ascending by date — `bucket` is a Date or an ISO string from
      // node-postgres depending on driver version, so we normalise.
      const ta = new Date(a.bucket as Date | string).getTime();
      const tb = new Date(b.bucket as Date | string).getTime();
      return ta - tb;
    });
  const ftdCount = Number(ftdRolling?.count ?? 0);
  const ftdTotal = Number(ftdRolling?.total ?? 0);

  // Windowed house P&L for the SELECTED period — derived from existing
  // aggregates instead of a separate calculateWindowedPnl() call. The
  // four components come from the one period query + the one composite
  // inventory/voucher query, both keyed off `periodCutoff`. Formula
  // matches calculateWindowedPnl:
  //   pnl = deposits − (manualWd + cardWd) − balanceChange − Δinv − Δvch
  //
  // Upgrader plays do not need a separate correction here: the bet
  // debit AND the win credit both flow through ledger_transactions
  // (upgrader_bet / upgrader_payout), so balance_change already
  // captures the net per-play move. A prior trailing `upgraderWonPeriod`
  // term was based on a stale assumption that the backend never wrote
  // upgrader_payout rows; that double-subtracted every upgrader win and
  // produced a -$150k+ phantom drag on the headline GGR / P&L cards.
  const depositsPeriod = num(pa.revenue);
  const cardWdPeriod = Math.abs(num(pa.withdrawal));
  const manualWdPeriod = num(pa.manual_wd);
  const balanceChangePeriod = num(pa.balance_change);
  const wd = windowedPeriodDelta[0] ?? {
    inv_obtained: "0",
    inv_disposed: "0",
    vch_issued: "0",
    vch_claimed: "0",
  };
  const inventoryChangePeriod = num(wd.inv_obtained) - num(wd.inv_disposed);
  const voucherChangePeriod = num(wd.vch_issued) - num(wd.vch_claimed);
  const realizedPnlPeriod =
    depositsPeriod -
    (manualWdPeriod + cardWdPeriod) -
    balanceChangePeriod -
    inventoryChangePeriod -
    voucherChangePeriod;

  // Daily upgrader wager keyed by ISO date (YYYY-MM-DD) so the
  // dailyWagers series can merge the `upgrader_games`-sourced upgrader
  // figure onto each ledger row's packs/battles. Empty map on a
  // pre-upgrader DB → every day's upgrader segment is 0.
  const dailyUpgraderByDate = new Map<string, number>(
    dailyUpgrader.map((d) => [
      new Date(d.date).toISOString().split("T")[0],
      Number(d.upgrader),
    ]),
  );

  return {
    // Selected period meta — drives the UI labels (so a card title can
    // read "Wager · Last 24h") without the client component re-deriving
    // the chip's friendly label.
    period,
    periodLabel: DASHBOARD_PERIOD_LABELS[period],
    users: {
      total: Number(userCounts[0]?.total ?? 0),
      today: Number(userCounts[0]?.today ?? 0),
      week: Number(userCounts[0]?.week ?? 0),
      month: Number(userCounts[0]?.month ?? 0),
    },
    // Gaming margin for the SELECTED period — the canonical
    // `@/lib/metrics` inventory-delta GGR (house POV; positive = house
    // up). GGR = wager (ledger WAGER_TYPES + upgrader bet) − (Σ
    // `user_inventory` win delta + |battle_refund| + upgrader payout),
    // real-customer + borrow-corrected scope. Pure GGR, no liability
    // adjustment — use realizedPnl for the balance-sheet-true number.
    //
    // Upgrader IS in this number now: `getGamingLegs` folds upgrader's
    // wager AND payout from `upgrader_games` (real gameplay; not in the
    // ledger), so the margin is two-legged and correct — the earlier
    // one-legged concern (which kept it out) is resolved because BOTH
    // sides are sourced from the upgrader-native table, not a phantom
    // ledger `upgrader_payout`. The GGR breakdown popover + the
    // contributor sweep both include upgrader to reconcile with this
    // headline; the dedicated Upgrader Stats panel still surfaces the
    // standalone upgrader margin with wins/losses/hit-rate. The previous
    // inline aggregate that subtracted the NEUTRAL card/voucher
    // conversions on the payout side is removed.
    ggr: windowMetrics.ggr,
    // Lifetime realized P&L from the house perspective — see getRealizedPnlSnapshot.
    // This is a single snapshot value, not a period series.
    realizedPnl: realizedPnlResult.pnl,
    // Rolling past-period house P&L (windowed delta — same formula as
    // calculateWindowedPnl but computed inline here from pieces that
    // periodAggregates + the windowedPeriodDelta query already produce).
    // Tracks the selected period via `periodCutoff` instead of being
    // 24h-only — flipping the global chip re-runs this.
    //
    // The windowedPeriodDelta query (inventoryChange / voucherChange
    // above) feeds INTO this number — it is not separately surfaced on
    // the payload anymore. A previous attempt (commit 8e1e835) exposed
    // `inventoryDeltaPeriod` / `voucherDeltaPeriod` so the GgrStatCard
    // could show a `P&L ≈ GGR − invΔ − vchΔ` reconciliation popover,
    // but that bridge is not a true accounting identity (it omits card
    // withdrawals and all non-GGR-typed credits like rain / rakeback /
    // gifts / tips / race prizes / bonuses, each of which can be tens
    // of thousands of dollars per window), so the popover was dropped
    // in favour of just the headline numbers.
    realizedPnlPeriod,
    // Total deposit dollar amount for the SELECTED period.
    deposits: depositsPeriod,
    // Deposit transaction COUNT for the SELECTED period. Pairs 1:1
    // with `deposits` so the Deposits card can show "$X across N
    // deposits" without a second roundtrip.
    depositCountPeriod: num(pa.deposit_count),
    // Fixed-window deposit counts (24h / 7d) for the "Deposits / hr"
    // KPI tile. Independent of the global period selector — the tile
    // always compares 24h average to a 7d baseline. Sourced from the
    // lightweight lifetimeDepositMetrics query.
    depositCount24h,
    depositCount7d,
    // Sourced from card_withdrawal_requests (status IN completed/
    // shipped) so the StatCard matches the PnL formula. Already a
    // positive magnitude; Math.abs is a defensive no-op.
    withdrawals: Math.abs(num(pa.withdrawal)),
    // Period count of completed/shipped card_withdrawal_requests —
    // pairs with `withdrawals` so the Withdrawals KPI card title can
    // show "Withdrawals · N" without a second roundtrip.
    withdrawalCountPeriod: num(pa.withdrawal_count),
    // Creator DEAL-PAYOUT cash-outs for the period — the dollar value of
    // creator deal-payout vouchers (creator_fill_conversion +
    // creator_multiplier_payout) that left the house via a completed/
    // shipped withdrawal request, plus the count of distinct such requests.
    // This is the house's REAL creator cost (deal payouts the creator
    // actually cashed out), NOT a creator's personal balance cash-out — so
    // the "Creator Deal Payouts (withdrawn)" tile reads as a true creator
    // cost. House POV: paying a creator = house outflow → rose.
    creatorWithdrawals: Math.abs(num(pa.creator_wd_amount)),
    creatorWithdrawalsCount: num(pa.creator_wd_count),
    // Customer wager — the dashboard's "Total Wager" card. Ledger
    // GAMEPLAY wager (packs + battles, creator-on-stream sessions
    // EXCLUDED) PLUS upgrader wager from `upgrader_games`. The two
    // ledger legs + the upgrader leg are the three breakdown chips
    // below, so they sum to this hero exactly.
    wagers: Math.abs(num(pa.wager_excl_session)) + upgraderWagerPeriod,
    // Per-source breakdown of the customer wager. Packs + Battles +
    // Upgrader add up to `wagers`. Packs/Battles come from the ledger
    // (NOT in_session filter, same as wager_excl_session); Upgrader
    // comes from `upgrader_games` (the canonical upgrader source — it is
    // NOT a ledger wager type).
    wagersBreakdown: {
      packs: Math.abs(num(pa.pack_wager_excl_session)),
      battles: Math.abs(num(pa.battle_wager_excl_session)),
      upgrader: upgraderWagerPeriod,
    },
    // Organic wager — customer GAMEPLAY wager from users who did NOT
    // join under an official creator code (referrer null or
    // non-creator). Excludes creator on-stream play via the same NOT
    // in_session filter as `wagers`. Surfaces volume not attributed to
    // creator marketing. Ledger gameplay only — the upgrader source
    // can't be split by creator-code attribution, so it is not added
    // here (this card is a distinct metric, not required to equal
    // Total Wager).
    wagersOrganic: Math.abs(num(pa.wager_organic)),
    // Raw wager — every non-staff user, INCLUDING creators' on-stream
    // sponsored play, plus upgrader. (wagersRaw − wagers) is the creator
    // deal/stream sponsored-balance contribution on the ledger legs.
    wagersRaw: Math.abs(num(pa.wager)) + upgraderWagerPeriod,
    financials: {
      totalDeposited: parseFloat(ba.total_deposited) || 0,
      totalWithdrawn: parseFloat(ba.total_withdrawn) || 0,
      totalWagered,
      totalWon,
      // totalSiteBalance / totalInventoryValue / totalUnclaimedVouchers
      // used to live here to drive the "Users Total Balance" liability
      // tile. The tile was retired during the perf pass (the underlying
      // user_inventory.aggregate scan was one of the heaviest queries on
      // the dashboard, and the figure is folded into realizedPnl
      // anyway), so we no longer surface the per-component breakdown
      // here. Lifetime PnL still consumes them internally via
      // getRealizedPnlSnapshot.
      avgDeposit:
        depositCount > 0
          ? (parseFloat(ba.total_deposited) || 0) / depositCount
          : 0,
      depositCount,
      // Unique players who have ever completed at least one deposit
      // (real users only; staff excluded via EXCLUDE_STAFF). Distinct
      // from depositCount above which counts deposit transactions —
      // a single user with five deposits = depositCount 5,
      // uniqueDepositors 1.
      uniqueDepositors: uniqueDepositorsResult,
      // First-time depositors in the rolling last 24h: count, the
      // summed value of those first deposits, and the average. The 24h
      // counterpart to uniqueDepositors (lifetime distinct depositors).
      ftds24h: ftdCount,
      ftdTotal24h: ftdTotal,
      ftdAvg24h: ftdCount > 0 ? ftdTotal / ftdCount : 0,
    },
    activity: {
      // Rolling 24h counts — drive the Recent Activity stats strip.
      // Real users only; admins / support / blacklisted accounts excluded.
      // signups24h now comes from the merged userCounts query (one
      // user-table scan instead of two).
      packsOpened24h,
      battlesPlayed24h,
      signups24h: Number(userCounts[0]?.rolling24h ?? 0),
    },
    dailyWagers: dailyChart.map((d) => {
      const date = new Date(d.date).toISOString().split("T")[0];
      return {
        date,
        packs: Number(d.packs),
        battles: Number(d.battles),
        // Upgrader segment sourced from `upgrader_games` (merged by
        // date), not the ledger. 0 on days with no upgrader plays or on
        // a pre-upgrader DB.
        upgrader: dailyUpgraderByDate.get(date) ?? 0,
      };
    }),
    dailyDeposits: dailyChart.map((d) => ({
      date: new Date(d.date).toISOString().split("T")[0],
      amount: Math.abs(Number(d.deposits)),
    })),
    dailySignups: dailySignups.map((d) => ({
      date: new Date(d.date).toISOString().split("T")[0],
      count: Number(d.count),
    })),
    // Daily FTDs — count + summed first-deposit value per day, plus the
    // derived average (total / count, guarded against div-by-zero).
    // Sourced from the ftdCombined UNION rows tagged 'daily'.
    dailyFtds: ftdDailyRows.map((d) => {
      const count = Number(d.count);
      const total = Number(d.total);
      return {
        date: new Date(d.bucket as Date | string).toISOString().split("T")[0],
        count,
        total,
        avg: count > 0 ? total / count : 0,
      };
    }),
    // Daily Active Depositors — distinct users who deposited each day
    // in the last 30 days. Sourced from the dailyChart 30-day ledger
    // scan (active_depositors column), which used to be a separate
    // 30-day scan.
    dailyActiveDepositors: dailyChart.map((d) => ({
      date: new Date(d.date).toISOString().split("T")[0],
      count: Number(d.active_depositors),
    })),
    // Daily Wager Attribution — organic (customers without a
    // creator-code referral) vs creator-coded (customers whose
    // referrer is a creator) per day for the last 30 days. The two
    // stack to the day's total customer wager. Excludes the creator
    // role itself + staff on both sides so neither bucket carries
    // creator-on-stream play.
    dailyWagerAttribution: dailyWagerAttribution.map((d) => ({
      date: new Date(d.date).toISOString().split("T")[0],
      organic: Number(d.organic),
      creatorCoded: Number(d.creator_attributed),
    })),
    // Server-side compute metadata. `queryMs` is the wall-clock time spent
    // in this function (exclusion lists + the parallel query batch + the
    // light post-processing above) — measured here at the very end so it
    // reflects the whole aggregate. `generatedAt` is the moment the data
    // was produced, for a "updated Ns ago" relative label. Both are plain
    // serializable primitives → safe across the RSC boundary.
    queryMs: Date.now() - t0,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Lightweight snapshot of the CURRENT rain for the dashboard's live box.
 * Deliberately NOT part of getDashboardStats — it's a single indexed row
 * lookup, so it streams behind its own Suspense and refreshes on the 60s
 * dashboard tick without adding to the heavy aggregate's query time.
 *
 * "Current" = the rain that's still in play: `active` (accepting entries)
 * or `drawing` (entries closed, picking a winner). Most recent by
 * starts_at. Returns null between rains (UI shows an idle state).
 * Participant count is read straight off rains.participant_count (kept in
 * sync by the main site), which equals the rain_entries head-count.
 */
export type ActiveRainSummary = {
  id: string;
  participantCount: number;
  totalPoolUsd: number;
  baseAmountUsd: number;
  tipAmountUsd: number;
  status: string;
  startsAt: string;
  endsAt: string;
} | null;

export async function getActiveRain(): Promise<ActiveRainSummary> {
  const db = await getDb();
  const rain = await db.rains.findFirst({
    where: { status: { in: ["active", "drawing"] } },
    orderBy: { starts_at: "desc" },
    select: {
      id: true,
      participant_count: true,
      total_pool_usd: true,
      base_amount_usd: true,
      tip_amount_usd: true,
      status: true,
      starts_at: true,
      ends_at: true,
    },
  });
  if (!rain) return null;
  return {
    id: rain.id,
    participantCount: rain.participant_count,
    totalPoolUsd: toNumber(rain.total_pool_usd),
    baseAmountUsd: toNumber(rain.base_amount_usd),
    tipAmountUsd: toNumber(rain.tip_amount_usd),
    status: rain.status,
    startsAt: rain.starts_at.toISOString(),
    endsAt: rain.ends_at.toISOString(),
  };
}

// ============================================================
// GGR breakdown — makes the headline GGR number auditable.
//
// Both helpers below now mirror the canonical `@/lib/metrics`
// inventory-delta GGR (NOT the old `_wager-payout-types.ts` 19-type
// payout list, which folded the NEUTRAL card/voucher conversions and a
// phantom ledger `upgrader_payout` into the payout side). The popover
// therefore reconciles with the headline `getWindowMetrics.ggr` by
// construction.
//
// `getGgrBreakdown` returns the canonical GGR LEGS for the window,
// with upgrader as a first-class slice on BOTH sides:
//   wagers  = packs & battles wager (ledger WAGER_TYPES) + upgrader
//             wager (`upgrader_games.bet_amount`)
//   payouts = pack/battle wins (the `user_inventory.value_at_obtained`
//             delta — the dominant payout, NOT a ledger type)
//             + battle refunds (the ledger cash gaming-payout legs)
//             + upgrader payout (`upgrader_games.won_amount`)
//   ggr     = wager − (inventory wins + battle refunds + upgrader payout)
//
// `getGgrTopContributors` is the per-user companion using the SAME
// model: per-user wager (ledger + upgrader) − (per-user inventory wins +
// per-user battle refunds + per-user upgrader payout). NOT cached upfront
// because the per-user ledger+inventory+upgrader join is heavier than the
// window aggregate; called lazily from a server action when the admin
// opens the expander.
//
// Upgrader is INCLUDED in both now — `getGamingLegs` folds it into the
// headline GGR from `upgrader_games` (real gameplay; not in the ledger),
// so the breakdown + contributors must contain it to reconcile. The
// dedicated Upgrader Stats panel still shows upgrader standalone
// (wins/losses/players/hit-rate) using the same canonical source.
// ============================================================

export type GgrBreakdownRow = {
  /** Display label for the leg (e.g. "Packs & battles wager", "Upgrader payout"). */
  type: string;
  /** Sum for the period. Always non-negative. */
  total: number;
};

export type GgrBreakdown = {
  /** Wager-side legs — money the user put at risk on games. */
  wagers: GgrBreakdownRow[];
  /** Payout-side legs — value returned to the user on games (inventory wins + battle_refund). */
  payouts: GgrBreakdownRow[];
  /** Sum of wager totals. */
  wagersTotal: number;
  /** Sum of payout totals. */
  payoutsTotal: number;
  /** wagersTotal − payoutsTotal — matches the headline GGR aggregate. */
  ggr: number;
};

/**
 * Canonical GGR legs for the selected period — the components that sum
 * to the headline GGR number. Backs the breakdown popover on the
 * dashboard's GgrStatCard.
 *
 * Reads the canonical `@/lib/metrics` `getGamingLegs` (real-customer +
 * borrow-corrected scope), so `ggr` here equals the headline
 * `getWindowMetrics.ggr` by construction (both read the same legs). The
 * wager side is shown as two rows — packs & battles stake (ledger
 * WAGER_TYPES) and upgrader stake (`upgrader_games.bet_amount`); the
 * payout side as three rows — the `user_inventory` win delta (the
 * dominant pack/battle payout), the ledger battle-refund cash legs, and
 * the upgrader payout (`upgrader_games.won_amount`). Upgrader is folded
 * into `legs.wager` / `legs.battleRefund` by `getGamingLegs`, so its
 * dedicated rows are carved out via `legs.upgraderWager` /
 * `legs.upgraderPayout` (NOT re-added — the bucket totals stay the full
 * folded sums, keeping the reconciliation exact). Per-ledger-type
 * granularity is intentionally gone from the payout side: the dominant
 * payout is NOT a ledger type under the verified booking model, and the
 * old per-type popover wrongly summed `card_sale` & friends into it.
 *
 * NOT separately cached — `getGamingLegs` is wrapped in its own timing
 * and the popover loads up-front with the (already cached) stats batch.
 */
export async function getGgrBreakdown(
  period: DashboardPeriod,
): Promise<GgrBreakdown> {
  const legs = await getGamingLegs(periodToMetricWindow(period, new Date()));

  // `getGamingLegs` now FOLDS upgrader into the headline legs:
  //   • legs.wager        = ledger pack/battle wager + upgrader wager
  //   • legs.battleRefund = ledger cash gaming-payout legs + upgrader payout
  // Each carries an upgrader-only slice (`upgraderWager` / `upgraderPayout`)
  // already INCLUDED in the totals — so we surface upgrader as its own
  // accurate row by subtracting that slice from the pack/battle row,
  // rather than re-reading. The bucket totals (`wagersTotal` /
  // `payoutsTotal`) are unchanged, so GGR still reconciles with the
  // headline `getWindowMetrics.ggr` by construction.
  const packBattleWager = legs.wager - legs.upgraderWager;
  const battleRefundLedger = legs.battleRefund - legs.upgraderPayout;

  // Wager side — pack/battle stake + upgrader stake as separate rows so
  // the label is accurate (no longer one misleading "pack & battle"
  // row that secretly contained upgrader). Wagers are flow-IN, shown
  // neutral in the popover.
  const wagers: GgrBreakdownRow[] = [
    { type: "Packs & battles wager", total: packBattleWager },
    { type: "Upgrader wager", total: legs.upgraderWager },
  ];
  // Payout side — the dominant pack/battle inventory win delta, the
  // ledger cash gaming-payout legs (battle refunds + battle-excess
  // vouchers), and the upgrader payout as its own row. Each shrinks the
  // house margin (rose in the popover).
  const payouts: GgrBreakdownRow[] = [
    { type: "Packs & battles wins (inventory)", total: legs.inventoryPayout },
    { type: "Battle refunds (cash)", total: battleRefundLedger },
    { type: "Upgrader payout", total: legs.upgraderPayout },
  ];
  const wagersTotal = legs.wager;
  const payoutsTotal = legs.inventoryPayout + legs.battleRefund;

  return {
    wagers,
    payouts,
    wagersTotal,
    payoutsTotal,
    ggr: wagersTotal - payoutsTotal,
  };
}

export type GgrTopContributorRow = {
  userId: string;
  username: string | null;
  /** Per-user gaming wager — ledger WAGER_TYPES (borrow-corrected) + upgrader bet. */
  wagerTotal: number;
  /** Per-user gaming payout — inventory pack/battle wins + |battle_refund| + upgrader payout. */
  payoutTotal: number;
  /** wagerTotal − payoutTotal. Positive = user lost (house profited). */
  net: number;
};

/**
 * Per-user net contribution to GGR for the selected period — drives
 * the "top contributors" expander inside the GGR breakdown popover.
 *
 * Uses the canonical inventory-delta model so each user's `net`
 * reconciles with the headline GGR definition: wager (ledger
 * WAGER_TYPES + upgrader bet) − (inventory pack/battle win delta +
 * |battle_refund| + upgrader payout), borrow-corrected on both sides
 * with reward/daily packs excluded. The borrow-exclusion subqueries, the
 * reward-pack exclusion (Fix 2), the direct battle_sponsorship count (Fix
 * 1) and the upgrader fold (`upgrader_games`, to_regclass-guarded) all
 * mirror the canonical `@/lib/metrics/queries` `getGamingLegs` /
 * `gaming-sql.ts` / `upgraderMetrics` EXACTLY — re-expressed inline here
 * only because that module exposes no per-USER builder (it is
 * window-aggregate only) and must not be edited from the dashboard. The
 * canonical SQL list constants are imported, so the type sets cannot
 * drift from the headline; the predicate text is kept byte-aligned with
 * gaming-sql.ts. The central session-window scope keeps creators on the
 * ledger/inventory legs (on-session rows dropped) while the upgrader leg
 * drops creators wholesale — the same documented asymmetry the headline
 * `getGamingLegs` carries.
 *
 * NOT cached — the per-user ledger+inventory join is heavier than the
 * window aggregate and the popover only loads it on click. Returns at
 * most `limit` rows (default 10), ordered by ABS(net) DESC.
 */
export async function getGgrTopContributors(
  period: DashboardPeriod,
  limit = 10,
): Promise<GgrTopContributorRow[]> {
  // Defensive clamp — server actions take a number from the client, so
  // an out-of-range value shouldn't blow up the query plan.
  const safeLimit = Math.max(1, Math.min(limit, 50));
  const db = await getDb();
  const excluded = await getExcludedUserIds();
  const blacklistIdNotIn = blacklistNotInClause("u.id", excluded);
  // Central canonical scope — staff + blacklist dropped, creators KEPT,
  // creator-on-session rows excluded via the session-window predicate.
  // Swept onto `@/lib/metrics/scope` so per-user GGR here uses the SAME
  // population as the headline `getWindowMetrics` (no more wholesale
  // creator drop; "one scope, fixed once").
  const scope = await getMetricsScope();
  const sessionWindowsCte = Prisma.raw(scope.sessionWindowsCte);
  const notInSessionLedger = Prisma.raw(
    scope.notInCreatorSession("lt.user_id", "lt.created_at"),
  );
  const notInSessionInv = Prisma.raw(
    scope.notInCreatorSession("ui.user_id", "ui.obtained_at"),
  );
  // Window cutoff for the per-user join. Derived from `periodToMetricWindow`
  // (NOT raw `periodToCutoff`) so the "all" chip maps to the SAME bounded
  // 365-day lookback the headline GGR uses — never an unbounded
  // `{ since: null }`. This (a) stops the heavy per-user ledger+inventory+
  // upgrader join running a full-history scan on the "all" chip (it had no
  // timeout/cache either), and (b) keeps each user's `net` reconciling with
  // the now-capped headline GGR for "all" (both bounded to the same 365-day
  // window). `periodToMetricWindow` never returns `since: null`, so there is
  // always a lower bound and the old `isAll → Prisma.empty` (drop the bound)
  // branch is gone.
  const cutoff = periodToMetricWindow(period, new Date()).since as Date;
  const sinceLedger = Prisma.sql`AND lt.created_at >= ${cutoff}`;
  const sinceInv = Prisma.sql`AND ui.obtained_at >= ${cutoff}`;
  const wagerIn = Prisma.raw(METRICS_WAGER_TYPES_SQL);
  const gamingPayoutIn = Prisma.raw(METRICS_GAMING_PAYOUT_TYPES_SQL);
  // Probe for the upgrader-native table (pre-upgrader DBs lack it —
  // to_regclass returns NULL, not an error). Gates the per-user upgrader
  // CTE below so it degrades to an empty leg rather than throwing 42P01.
  // Mirrors the canonical `upgraderMetrics` guard so the per-user net
  // folds upgrader on the SAME DBs the headline does.
  const upgProbe = await db.$queryRaw<{ exists: string | null }[]>`
    SELECT to_regclass('public.upgrader_games')::text AS exists`;
  const hasUpgrader = upgProbe[0]?.exists != null;
  // Per-user upgrader leg from `upgrader_games` (real gameplay, NOT in
  // the ledger). Folded into wager + payout BEFORE the ORDER BY/LIMIT so
  // a heavy-upgrader user can't be ranked out of the top-N by the
  // pack/battle-only sort. Mirrors the canonical `upgraderMetrics`
  // EXACTLY: wholesale creator drop (`role NOT IN ('admin','support',
  // 'creator')`) + blacklist, summing `bet_amount` / `won_amount`. On a
  // pre-upgrader DB the CTE is a no-op stub (`WHERE false`) so every
  // user's upgrader contribution is 0 and the join is harmless.
  //
  // SCOPE ASYMMETRY (documented, intentional, matches getGamingLegs):
  // the ledger/inventory legs use the session-window scope (creators
  // KEPT, on-session rows dropped), while this upgrader leg drops
  // creators wholesale — exactly as the headline `getGamingLegs` folds
  // upgrader via `upgraderMetrics`. So per-user net reconciles with the
  // headline GGR for every non-creator user; a creator's upgrader play
  // never appears here (nor in the headline), only their off-session
  // pack/battle play does.
  // Same bounded `cutoff` as the ledger/inventory legs (capped 365-day for
  // the "all" chip via `periodToMetricWindow`), so the per-user upgrader
  // leg never runs an unbounded `upgrader_games` scan and stays aligned
  // with the headline window.
  const sinceUpg = Prisma.sql`AND ug.created_at >= ${cutoff}`;
  const upgraderLegCte = hasUpgrader
    ? Prisma.sql`
      upgrader_leg AS (
        SELECT
          ug.user_id,
          COALESCE(SUM(ug.bet_amount::numeric), 0) AS upg_wager,
          COALESCE(SUM(ug.won_amount::numeric), 0) AS upg_payout
        FROM upgrader_games ug
        WHERE ug.user_id IN (
          -- Wholesale creator drop + blacklist -- identical scope to the
          -- canonical upgraderMetrics. blacklistIdNotIn is keyed on
          -- "u.id", which matches this aliased subquery.
          SELECT u.id FROM "user" u
          WHERE u.role NOT IN ('admin', 'support', 'creator') ${Prisma.raw(
            blacklistIdNotIn,
          )}
        )
        ${sinceUpg}
        GROUP BY ug.user_id
      )`
    : Prisma.sql`
      upgrader_leg AS (
        -- Pre-upgrader DB: empty stub so the LEFT JOIN below contributes 0.
        SELECT NULL::text AS user_id, 0::numeric AS upg_wager, 0::numeric AS upg_payout
        WHERE false
      )`;
  // Reward/daily-pack session set (Fix 2) — `pack_type='reward'` opens
  // are $0-wager card giveaways tracked as a reward cost elsewhere, so
  // they are dropped from BOTH the wager leg (their game_session_id) and
  // the won-card inventory leg (their source_id). Mirrors the canonical
  // `gaming-sql.ts` REWARD_PACK_SESSIONS exactly so per-user GGR matches
  // the headline; expressed inline as a CTE alongside the borrow CTEs
  // (the `@/lib/metrics` module exposes no per-USER builder to call).
  // Per-user inventory-delta GGR. Three per-user aggregates merged by
  // user_id:
  //   • ledger leg — wager (Σ|amount| over WAGER_TYPES, borrow-
  //     corrected) + battle_refund (Σ|amount| over GAMING_PAYOUT_TYPES,
  //     the cash winner leg).
  //   • inventory leg — Σ value_at_obtained for source pack/battle,
  //     obtained in window, borrow-corrected (the dominant payout).
  //   • upgrader leg — Σ bet_amount / won_amount from `upgrader_games`
  //     (the headline GGR now includes upgrader, so per-user must too).
  // wager_total = ledger wager + upgrader wager; payout_total =
  // inventory wins + battle_refund + upgrader payout; net = wager − payout.
  // Borrow-exclusion subqueries mirror the canonical layer (drop pack
  // opens tagged "borrow" + battle plays on borrow_percentage>0); reward
  // packs are dropped on both legs (Fix 2); battle_sponsorship is counted
  // DIRECTLY (no borrow gate — its game_session_id is NULL, all sponsored
  // battles are borrow_percentage=0; Fix 1). Creator-on-session rows are
  // dropped on the ledger+inventory legs via the central session-window
  // predicate (symmetric, keyed on created_at / obtained_at).
  const rows = await db.$queryRaw<
    {
      user_id: string;
      username: string | null;
      wager_total: string;
      payout_total: string;
      net: string;
    }[]
  >`
    WITH ${sessionWindowsCte},
    real_users AS (
      -- Staff (admin/support) + blacklist dropped; creators KEPT (their
      -- on-session rows are removed per-row in the legs below). Role list
      -- matches @/lib/metrics/scope STAFF_ROLES.
      SELECT u.id, u.username
      FROM "user" u
      WHERE u.role NOT IN ('admin', 'support') ${Prisma.raw(blacklistIdNotIn)}
    ),
    non_borrow_pack_sessions AS (
      SELECT game_session_id FROM ledger_transactions
      WHERE type::text = 'pack_opening' AND status = 'completed'
        AND game_session_id IS NOT NULL
        AND (description IS NULL OR description NOT ILIKE '%borrow%')
    ),
    non_borrow_battle_sessions AS (
      SELECT bp.game_session_id FROM battle_participants bp
      JOIN battles b ON b.id = bp.battle_id
      WHERE COALESCE(b.borrow_percentage, 0) = 0
    ),
    reward_pack_sessions AS (
      -- Reward/daily-pack opens (game_type='pack' → packs.pack_type=
      -- 'reward'). Dropped from both the wager leg and the won-card
      -- inventory leg (Fix 2). Mirrors gaming-sql.ts REWARD_PACK_SESSIONS.
      SELECT gs.id FROM game_sessions gs
      JOIN packs p ON p.id = gs.game_id AND p.pack_type = 'reward'
      WHERE gs.game_type = 'pack'
    ),
    ${upgraderLegCte},
    ledger_leg AS (
      SELECT
        lt.user_id,
        COALESCE(SUM(CASE WHEN lt.type::text IN ${wagerIn}
                          THEN ABS(lt.amount::numeric) ELSE 0 END), 0) AS wager_total,
        COALESCE(SUM(CASE WHEN lt.type::text IN ${gamingPayoutIn}
                          THEN ABS(lt.amount::numeric) ELSE 0 END), 0) AS battle_refund_total
      FROM ledger_transactions lt
      JOIN real_users ru ON ru.id = lt.user_id
      WHERE lt.status = 'completed'
        AND ${notInSessionLedger}
        ${sinceLedger}
        AND (
          lt.type::text NOT IN ('pack_opening','battle_bet','battle_sponsorship')
          -- pack_opening: non-borrow AND not a reward/daily pack (Fix 2).
          -- The game_session_id IS NULL guard keeps a NULL-session open
          -- (definitionally not a reward pack) counted instead of dropped.
          OR (lt.type::text = 'pack_opening'
              AND (lt.description IS NULL OR lt.description NOT ILIKE '%borrow%')
              AND (lt.game_session_id IS NULL OR lt.game_session_id NOT IN (SELECT id FROM reward_pack_sessions)))
          -- battle_bet keeps the borrow gate (its battle may be on borrow).
          OR (lt.type::text = 'battle_bet' AND lt.game_session_id IN (SELECT game_session_id FROM non_borrow_battle_sessions))
          -- battle_sponsorship counted DIRECTLY — no borrow gate (Fix 1).
          -- Its game_session_id is NULL, so the IN-gate would drop every
          -- sponsorship row (the headline-omits-sponsorship bug); all
          -- sponsored battles are borrow_percentage=0 so no gate is needed.
          OR lt.type::text = 'battle_sponsorship'
        )
      GROUP BY lt.user_id
    ),
    inv_leg AS (
      SELECT
        ui.user_id,
        COALESCE(SUM(ui.value_at_obtained::numeric), 0) AS inv_payout
      FROM user_inventory ui
      JOIN real_users ru ON ru.id = ui.user_id
      WHERE ui.source_type IN ('pack','battle')
        AND ${notInSessionInv}
        ${sinceInv}
        AND (
          (ui.source_type = 'pack' AND ui.source_id IN (SELECT game_session_id FROM non_borrow_pack_sessions))
          OR (ui.source_type = 'battle' AND ui.source_id IN (SELECT game_session_id FROM non_borrow_battle_sessions))
        )
        -- Reward/daily-pack won cards dropped (Fix 2), keyed on source_id
        -- (the originating game_session_id). NULL source_id stays counted.
        AND (ui.source_id IS NULL OR ui.source_id NOT IN (SELECT id FROM reward_pack_sessions))
      GROUP BY ui.user_id
    ),
    per_user AS (
      SELECT
        ru.id AS user_id,
        ru.username,
        -- wager = ledger pack/battle wager + upgrader wager.
        COALESCE(l.wager_total, 0) + COALESCE(g.upg_wager, 0) AS wager_total,
        -- payout = inventory pack/battle wins + battle refunds + upgrader payout.
        COALESCE(i.inv_payout, 0)
          + COALESCE(l.battle_refund_total, 0)
          + COALESCE(g.upg_payout, 0) AS payout_total
      FROM real_users ru
      LEFT JOIN ledger_leg l ON l.user_id = ru.id
      LEFT JOIN inv_leg i ON i.user_id = ru.id
      LEFT JOIN upgrader_leg g ON g.user_id = ru.id
      -- Keep any user with non-zero activity on ANY leg (incl. upgrader-
      -- only players) so the top-N sort sees them.
      WHERE COALESCE(l.wager_total, 0) <> 0
         OR COALESCE(i.inv_payout, 0) <> 0
         OR COALESCE(l.battle_refund_total, 0) <> 0
         OR COALESCE(g.upg_wager, 0) <> 0
         OR COALESCE(g.upg_payout, 0) <> 0
    )
    SELECT
      pu.user_id::text AS user_id,
      pu.username,
      pu.wager_total::text AS wager_total,
      pu.payout_total::text AS payout_total,
      (pu.wager_total - pu.payout_total)::text AS net
    FROM per_user pu
    ORDER BY ABS(pu.wager_total - pu.payout_total) DESC
    LIMIT ${safeLimit}
  `;
  return rows.map((r) => ({
    userId: r.user_id,
    username: r.username,
    wagerTotal: parseFloat(r.wager_total) || 0,
    payoutTotal: parseFloat(r.payout_total) || 0,
    net: parseFloat(r.net) || 0,
  }));
}
