import { cache } from "react";
import { getDb } from "@/lib/db";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import { MS_PER_DAY, MS_PER_HOUR } from "@/lib/utils/time";
import {
  excludeStaffAndBlacklisted,
  excludeStaffAndBlacklistedDirect,
  blacklistNotInClause,
} from "./_blacklist";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getRealizedPnlSnapshot } from "./_realized-pnl";
import { calculateWindowedPnl } from "./pnl";
import { getCreatorSessionWindowsCte } from "./creator-session-windows";
import {
  WAGER_TYPES_SQL,
  PAYOUT_TYPES_SQL,
} from "./_wager-payout-types";

/**
 * Single raw query that returns revenue (deposits), withdrawal, wager and GGR
 * totals bucketed by period in ONE round-trip. Previously this was 20
 * separate aggregate calls (4 metrics × 5 periods) — each requires its own
 * plan + execution, and the underlying index scan is the same. Collapsing
 * into one query shaves ~15 round-trips off the hot dashboard path.
 *
 * All cutoffs are TRUE ROLLING WINDOWS from `now` (1h ago, 3h ago, …,
 * 24h ago, 3d ago …). The 24h bucket used to be `startOfDay` (UTC
 * midnight = calendar day) which made the card reset to zero every
 * midnight and read like a partial half-day for most of the morning
 * — out of step with the other rolling chips on the same card. The
 * fix unifies the semantic: every chip is now `now − N`.
 *
 * Row shape: one text column per (metric × period). Caller converts to
 * number via toNumber / parseFloat.
 *
 * Note on withdrawals: revenue/wager/GGR come from `ledger_transactions`,
 * but withdrawals come from `card_withdrawal_requests` (status IN
 * completed/shipped) so the StatCard matches the PnL formula's source of
 * truth. Some pre-Fireblocks completions never got their ledger entry's
 * status flipped to 'completed' — those withdrawals are real (money left
 * the house) but a ledger-based query misses them. The request table is
 * the authoritative record.
 */
function getPeriodAggregates(
  db: PrismaClient,
  oneHourAgo: Date,
  threeHoursAgo: Date,
  sixHoursAgo: Date,
  twelveHoursAgo: Date,
  // Rolling 24h cutoff — `now − 24h`. NOT the start of the UTC day.
  // Renamed from the old `startOfDay` to make the new semantic
  // obvious at every call site.
  twentyFourHoursAgo: Date,
  threeDaysAgo: Date,
  sevenDaysAgo: Date,
  thirtyDaysAgo: Date,
  blacklistIdNotIn: string,
  // A `session_windows(uid, win_start, win_end)` CTE definition (built
  // by getCreatorSessionWindowsCte) — every creator deal/stream session.
  // Wagers a creator made inside one of these windows are dropped from
  // the customer wager figure.
  sessionWindowsCte: string,
) {
  // GGR wager/payout type sets — built ONCE from the canonical shared
  // constants (src/lib/queries/_wager-payout-types.ts) and interpolated
  // into every GGR period block below via Prisma.raw, instead of being
  // re-typed inline 9× (where the 19-item payout list inevitably drifts).
  // The values are hardcoded ledger-type strings — no external input —
  // so Prisma.raw is injection-safe here.
  const ggrWagerIn = Prisma.raw(WAGER_TYPES_SQL);
  const ggrPayoutIn = Prisma.raw(PAYOUT_TYPES_SQL);
  return db.$queryRaw<
    {
      revenue_1h: string; revenue_3h: string; revenue_6h: string; revenue_12h: string;
      revenue_24h: string; revenue_3d: string; revenue_7d: string; revenue_30d: string; revenue_all: string;
      withdrawal_1h: string; withdrawal_3h: string; withdrawal_6h: string; withdrawal_12h: string;
      withdrawal_24h: string; withdrawal_3d: string; withdrawal_7d: string; withdrawal_30d: string; withdrawal_all: string;
      wager_1h: string; wager_3h: string; wager_6h: string; wager_12h: string;
      wager_24h: string; wager_3d: string; wager_7d: string; wager_30d: string; wager_all: string;
      // Customer wager — wager_* MINUS wagers a creator made while live
      // on a deal/stream (house-funded "sponsored" play).
      wager_excl_session_1h: string; wager_excl_session_3h: string; wager_excl_session_6h: string; wager_excl_session_12h: string;
      wager_excl_session_24h: string; wager_excl_session_3d: string; wager_excl_session_7d: string; wager_excl_session_30d: string; wager_excl_session_all: string;
      ggr_1h: string; ggr_3h: string; ggr_6h: string; ggr_12h: string;
      ggr_24h: string; ggr_3d: string; ggr_7d: string; ggr_30d: string; ggr_all: string;
      // Deposit COUNT (number of completed deposit transactions) per
      // period. Pairs with the existing revenue_* (sum) columns so the
      // Deposits KPI card can show "$X across N deposits" on the same
      // period selector.
      deposit_count_1h: string; deposit_count_3h: string; deposit_count_6h: string; deposit_count_12h: string;
      deposit_count_24h: string; deposit_count_3d: string; deposit_count_7d: string; deposit_count_30d: string; deposit_count_all: string;
      // Distinct real users who placed a wager (pack_opening / battle_bet /
      // battle_sponsorship) in the rolling last 24h. Engagement headcount —
      // not money — so it lives next to the wager columns but is a COUNT
      // DISTINCT. Computed off the same `base` CTE (already staff +
      // blacklist filtered, status='completed'), so it costs no extra
      // round-trip.
      active_users_24h: string;
    }[]
  >`
    WITH real_users AS (
      SELECT id, role FROM "user" WHERE role NOT IN ('admin', 'support') ${Prisma.raw(blacklistIdNotIn)}
    ),
    ${Prisma.raw(sessionWindowsCte)},
    base AS (
      -- in_session marks a wager a creator made while live on a deal/
      -- stream — its created_at falls inside one of that creator's
      -- session windows. Creators wager house-funded "sponsored"
      -- balance on stream, which is not a real customer bet, so the
      -- customer wager figure drops these rows. The CASE keeps the
      -- EXISTS subquery off the hot path for non-creator rows.
      SELECT lt.user_id, lt.type, lt.amount::numeric AS amount, lt.created_at,
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
        total_value_usd::numeric AS amount,
        -- Use shipped_at as the "money out" timestamp when completed_at is
        -- not yet set (status='shipped'). For status='completed' both
        -- timestamps are usually populated; completed_at wins.
        COALESCE(completed_at, shipped_at) AS effective_at
      FROM card_withdrawal_requests
      WHERE status IN ('completed', 'shipped')
        AND user_id IN (SELECT id FROM real_users)
    )
    SELECT
      COALESCE(SUM(CASE WHEN type = 'deposit' AND created_at >= ${oneHourAgo}     THEN amount ELSE 0 END), 0)::text AS revenue_1h,
      COALESCE(SUM(CASE WHEN type = 'deposit' AND created_at >= ${threeHoursAgo}  THEN amount ELSE 0 END), 0)::text AS revenue_3h,
      COALESCE(SUM(CASE WHEN type = 'deposit' AND created_at >= ${sixHoursAgo}    THEN amount ELSE 0 END), 0)::text AS revenue_6h,
      COALESCE(SUM(CASE WHEN type = 'deposit' AND created_at >= ${twelveHoursAgo} THEN amount ELSE 0 END), 0)::text AS revenue_12h,
      COALESCE(SUM(CASE WHEN type = 'deposit' AND created_at >= ${twentyFourHoursAgo}    THEN amount ELSE 0 END), 0)::text AS revenue_24h,
      COALESCE(SUM(CASE WHEN type = 'deposit' AND created_at >= ${threeDaysAgo}  THEN amount ELSE 0 END), 0)::text AS revenue_3d,
      COALESCE(SUM(CASE WHEN type = 'deposit' AND created_at >= ${sevenDaysAgo}  THEN amount ELSE 0 END), 0)::text AS revenue_7d,
      COALESCE(SUM(CASE WHEN type = 'deposit' AND created_at >= ${thirtyDaysAgo} THEN amount ELSE 0 END), 0)::text AS revenue_30d,
      COALESCE(SUM(CASE WHEN type = 'deposit'                                    THEN amount ELSE 0 END), 0)::text AS revenue_all,

      COALESCE((SELECT SUM(CASE WHEN effective_at >= ${oneHourAgo}     THEN amount ELSE 0 END) FROM withdrawals), 0)::text AS withdrawal_1h,
      COALESCE((SELECT SUM(CASE WHEN effective_at >= ${threeHoursAgo}  THEN amount ELSE 0 END) FROM withdrawals), 0)::text AS withdrawal_3h,
      COALESCE((SELECT SUM(CASE WHEN effective_at >= ${sixHoursAgo}    THEN amount ELSE 0 END) FROM withdrawals), 0)::text AS withdrawal_6h,
      COALESCE((SELECT SUM(CASE WHEN effective_at >= ${twelveHoursAgo} THEN amount ELSE 0 END) FROM withdrawals), 0)::text AS withdrawal_12h,
      COALESCE((SELECT SUM(CASE WHEN effective_at >= ${twentyFourHoursAgo}    THEN amount ELSE 0 END) FROM withdrawals), 0)::text AS withdrawal_24h,
      COALESCE((SELECT SUM(CASE WHEN effective_at >= ${threeDaysAgo}  THEN amount ELSE 0 END) FROM withdrawals), 0)::text AS withdrawal_3d,
      COALESCE((SELECT SUM(CASE WHEN effective_at >= ${sevenDaysAgo}  THEN amount ELSE 0 END) FROM withdrawals), 0)::text AS withdrawal_7d,
      COALESCE((SELECT SUM(CASE WHEN effective_at >= ${thirtyDaysAgo} THEN amount ELSE 0 END) FROM withdrawals), 0)::text AS withdrawal_30d,
      COALESCE((SELECT SUM(amount)                                                            FROM withdrawals), 0)::text AS withdrawal_all,

      COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship') AND created_at >= ${oneHourAgo}     THEN amount ELSE 0 END), 0)::text AS wager_1h,
      COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship') AND created_at >= ${threeHoursAgo}  THEN amount ELSE 0 END), 0)::text AS wager_3h,
      COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship') AND created_at >= ${sixHoursAgo}    THEN amount ELSE 0 END), 0)::text AS wager_6h,
      COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship') AND created_at >= ${twelveHoursAgo} THEN amount ELSE 0 END), 0)::text AS wager_12h,
      COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship') AND created_at >= ${twentyFourHoursAgo}    THEN amount ELSE 0 END), 0)::text AS wager_24h,
      COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship') AND created_at >= ${threeDaysAgo}  THEN amount ELSE 0 END), 0)::text AS wager_3d,
      COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship') AND created_at >= ${sevenDaysAgo}  THEN amount ELSE 0 END), 0)::text AS wager_7d,
      COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship') AND created_at >= ${thirtyDaysAgo} THEN amount ELSE 0 END), 0)::text AS wager_30d,
      COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship')                                    THEN amount ELSE 0 END), 0)::text AS wager_all,

      -- Customer wager — the wager_* set MINUS wagers a creator made
      -- while live on a deal/stream (in_session). Creators wager
      -- house-funded "sponsored" balance on stream — recorded as
      -- ordinary pack_opening/battle_bet rows — which is not a real
      -- customer bet. A creator's OFF-session personal play stays in.
      COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship') AND NOT in_session AND created_at >= ${oneHourAgo}     THEN amount ELSE 0 END), 0)::text AS wager_excl_session_1h,
      COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship') AND NOT in_session AND created_at >= ${threeHoursAgo}  THEN amount ELSE 0 END), 0)::text AS wager_excl_session_3h,
      COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship') AND NOT in_session AND created_at >= ${sixHoursAgo}    THEN amount ELSE 0 END), 0)::text AS wager_excl_session_6h,
      COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship') AND NOT in_session AND created_at >= ${twelveHoursAgo} THEN amount ELSE 0 END), 0)::text AS wager_excl_session_12h,
      COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship') AND NOT in_session AND created_at >= ${twentyFourHoursAgo}    THEN amount ELSE 0 END), 0)::text AS wager_excl_session_24h,
      COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship') AND NOT in_session AND created_at >= ${threeDaysAgo}  THEN amount ELSE 0 END), 0)::text AS wager_excl_session_3d,
      COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship') AND NOT in_session AND created_at >= ${sevenDaysAgo}  THEN amount ELSE 0 END), 0)::text AS wager_excl_session_7d,
      COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship') AND NOT in_session AND created_at >= ${thirtyDaysAgo} THEN amount ELSE 0 END), 0)::text AS wager_excl_session_30d,
      COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship') AND NOT in_session                                    THEN amount ELSE 0 END), 0)::text AS wager_excl_session_all,

      -- GGR = wagers − payouts (industry-standard pure gaming margin).
      -- The wager (ggrWagerIn) + payout (ggrPayoutIn) type sets are
      -- interpolated from the canonical shared constants in
      -- src/lib/queries/_wager-payout-types.ts (the same lists creators-pnl.ts
      -- uses), so the dashboard's global GGR can never drift from the
      -- per-creator GGR. Change the lists in that one file, not here.
      (
        COALESCE(SUM(CASE WHEN type IN ${ggrWagerIn} AND created_at >= ${oneHourAgo} THEN ABS(amount) ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN type IN ${ggrPayoutIn} AND created_at >= ${oneHourAgo} THEN ABS(amount) ELSE 0 END), 0)
      )::text AS ggr_1h,
      (
        COALESCE(SUM(CASE WHEN type IN ${ggrWagerIn} AND created_at >= ${threeHoursAgo} THEN ABS(amount) ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN type IN ${ggrPayoutIn} AND created_at >= ${threeHoursAgo} THEN ABS(amount) ELSE 0 END), 0)
      )::text AS ggr_3h,
      (
        COALESCE(SUM(CASE WHEN type IN ${ggrWagerIn} AND created_at >= ${sixHoursAgo} THEN ABS(amount) ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN type IN ${ggrPayoutIn} AND created_at >= ${sixHoursAgo} THEN ABS(amount) ELSE 0 END), 0)
      )::text AS ggr_6h,
      (
        COALESCE(SUM(CASE WHEN type IN ${ggrWagerIn} AND created_at >= ${twelveHoursAgo} THEN ABS(amount) ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN type IN ${ggrPayoutIn} AND created_at >= ${twelveHoursAgo} THEN ABS(amount) ELSE 0 END), 0)
      )::text AS ggr_12h,
      (
        COALESCE(SUM(CASE WHEN type IN ${ggrWagerIn} AND created_at >= ${twentyFourHoursAgo} THEN ABS(amount) ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN type IN ${ggrPayoutIn} AND created_at >= ${twentyFourHoursAgo} THEN ABS(amount) ELSE 0 END), 0)
      )::text AS ggr_24h,
      (
        COALESCE(SUM(CASE WHEN type IN ${ggrWagerIn} AND created_at >= ${threeDaysAgo} THEN ABS(amount) ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN type IN ${ggrPayoutIn} AND created_at >= ${threeDaysAgo} THEN ABS(amount) ELSE 0 END), 0)
      )::text AS ggr_3d,
      (
        COALESCE(SUM(CASE WHEN type IN ${ggrWagerIn} AND created_at >= ${sevenDaysAgo} THEN ABS(amount) ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN type IN ${ggrPayoutIn} AND created_at >= ${sevenDaysAgo} THEN ABS(amount) ELSE 0 END), 0)
      )::text AS ggr_7d,
      (
        COALESCE(SUM(CASE WHEN type IN ${ggrWagerIn} AND created_at >= ${thirtyDaysAgo} THEN ABS(amount) ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN type IN ${ggrPayoutIn} AND created_at >= ${thirtyDaysAgo} THEN ABS(amount) ELSE 0 END), 0)
      )::text AS ggr_30d,
      (
        COALESCE(SUM(CASE WHEN type IN ${ggrWagerIn} THEN ABS(amount) ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN type IN ${ggrPayoutIn} THEN ABS(amount) ELSE 0 END), 0)
      )::text AS ggr_all,

      -- Deposit COUNT per period. Same window definitions as the
      -- revenue_* (sum) columns so the Deposits card can show both
      -- "$X" and "N deposits" on a single period selector. COUNT()
      -- with FILTER (CASE WHEN ... THEN 1 END) — only counts rows
      -- where the condition is true; null rows are skipped.
      COUNT(CASE WHEN type = 'deposit' AND created_at >= ${oneHourAgo}        THEN 1 END)::text AS deposit_count_1h,
      COUNT(CASE WHEN type = 'deposit' AND created_at >= ${threeHoursAgo}     THEN 1 END)::text AS deposit_count_3h,
      COUNT(CASE WHEN type = 'deposit' AND created_at >= ${sixHoursAgo}       THEN 1 END)::text AS deposit_count_6h,
      COUNT(CASE WHEN type = 'deposit' AND created_at >= ${twelveHoursAgo}    THEN 1 END)::text AS deposit_count_12h,
      COUNT(CASE WHEN type = 'deposit' AND created_at >= ${twentyFourHoursAgo} THEN 1 END)::text AS deposit_count_24h,
      COUNT(CASE WHEN type = 'deposit' AND created_at >= ${threeDaysAgo}      THEN 1 END)::text AS deposit_count_3d,
      COUNT(CASE WHEN type = 'deposit' AND created_at >= ${sevenDaysAgo}      THEN 1 END)::text AS deposit_count_7d,
      COUNT(CASE WHEN type = 'deposit' AND created_at >= ${thirtyDaysAgo}     THEN 1 END)::text AS deposit_count_30d,
      COUNT(CASE WHEN type = 'deposit'                                         THEN 1 END)::text AS deposit_count_all,

      -- Active players in the rolling last 24h — distinct real users who
      -- placed a wager (pack_opening / battle_bet / battle_sponsorship)
      -- since now - 24h. The base CTE is already JOINed to real_users
      -- (staff + blacklist excluded) and filtered to status='completed', so
      -- this is a free COUNT(DISTINCT) off the same scan. Engagement metric
      -- → neutral/blue tile, no money sign.
      COUNT(DISTINCT CASE
        WHEN type IN ('pack_opening','battle_bet','battle_sponsorship')
             AND created_at >= ${twentyFourHoursAgo}
        THEN user_id END)::text AS active_users_24h
    FROM base
  `;
}

// Lifetime realized P&L lives in src/lib/queries/_realized-pnl.ts so the
// Analytics page can use the exact same definition. Do not inline it here.

/**
 * Per-request memoized. The dashboard page streams several independent
 * Suspense segments (KPI strips, charts, the activity count strip) that
 * each read these stats; `cache()` ensures the heavy 17-query aggregate
 * runs once per render, not once per segment. Cross-request caching is
 * intentionally omitted — these are live platform numbers and the page
 * already revalidates them via the 60s AutoRefresh.
 */
export const getDashboardStats = cache(async () => {
  return withTiming("dashboard.getDashboardStats", () => dashboardStatsInner());
});

async function dashboardStatsInner() {
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
  const [staffRelation, staffRoleDirect, excluded, sessionWindowsCte] =
    await Promise.all([
      excludeStaffAndBlacklisted(),
      excludeStaffAndBlacklistedDirect(),
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

  const oneHourAgo = new Date(now.getTime() - 1 * MS_PER_HOUR);
  const threeHoursAgo = new Date(now.getTime() - 3 * MS_PER_HOUR);
  const sixHoursAgo = new Date(now.getTime() - 6 * MS_PER_HOUR);
  const twelveHoursAgo = new Date(now.getTime() - 12 * MS_PER_HOUR);
  const threeDaysAgo = new Date(now.getTime() - 3 * MS_PER_DAY);
  const sevenDaysAgo = new Date(now.getTime() - 7 * MS_PER_DAY);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * MS_PER_DAY);
  // Rolling 24h cutoff (now − 24h, NOT UTC midnight). Used by every
  // "24h" surface on the dashboard:
  //   • Period aggregates (revenue / wager / GGR / withdrawal "24h" KPI cards)
  //   • The 24h Activity tile (pack openings + battles count)
  // The card chips next to "24h" are 1h / 3h / 6h / 12h / 3d / 7d / 30d
  // — all rolling. Making "24h" rolling too keeps the row coherent.
  const rolling24h = new Date(now.getTime() - 1 * MS_PER_DAY);

  // Perf audit (2026-05-11): the Promise.all below previously fired
  // 25 parallel queries per dashboard refresh, several of which fed
  // return-shape fields that the UI no longer renders. Dropped queries:
  //   • bannedUsers / lockedUsers  → users.banned/locked were unused
  //   • pendingWithdrawals (status IN pending/processing)  → unused
  //   • pendingConfirmationWithdrawals (status = pending) → unused
  //   • totalAuditEvents (adminDb count) + totalTransactions (ledger count)
  //     → only fed totalActivityCount, which was unused
  // Plus two structural merges:
  //   • two `balances.aggregate` calls collapsed into one (adds
  //     available_balance to the existing _sum block — same plan, one
  //     round-trip instead of two)
  //   • depositCount now reuses `pa.deposit_count_all` from the period
  //     aggregates CTE — the count was being recomputed redundantly
  // Net: 25 queries → 17 queries per refresh (-8) and one fewer adminDb
  // round-trip. Compounded with the 15s→60s AutoRefresh cadence change,
  // dashboard polling load drops by roughly 8×.
  const [
    userCounts,
    balanceAggregates,
    packStats,
    dailyChart,
    dailySignups,
    periodAggregates,
    activityTotals,
    uniqueDepositorsResult,
    realizedPnlResult,
    realizedPnl24hResult,
    totalInventoryValue,
    packsOpened24h,
    battlesPlayed24h,
    signups24h,
    ftdResult,
    pendingWithdrawalsResult,
    dailyFtds,
    dailyActiveDepositors,
  ] = await Promise.all([
    // All four user counts (total + new today/week/month) in ONE scan of
    // the user table via COUNT(*) FILTER, instead of four separate
    // round-trips. STAFF_ROLES (admin + support) + blacklist excluded so
    // the KPI strip reads only real customers — matches staffRelation.
    db.$queryRaw<{ total: string; today: string; week: string; month: string }[]>`
      SELECT
        COUNT(*)::text AS total,
        COUNT(*) FILTER (WHERE created_at >= ${startOfDay})::text AS today,
        COUNT(*) FILTER (WHERE created_at >= ${startOfWeek})::text AS week,
        COUNT(*) FILTER (WHERE created_at >= ${startOfMonth})::text AS month
      FROM "user"
      WHERE role NOT IN ('admin', 'support') ${Prisma.raw(blacklistIdNotIn)}
    `,
    // Single balances aggregate — `available_balance` is folded in with
    // the lifetime _sums so the dashboard pays one round-trip, not two.
    // The `Users Total Balance` tile + lifetime financial KPIs all draw
    // from this row.
    db.balances.aggregate({
      where: { user: staffRelation },
      _sum: {
        total_deposited: true,
        total_withdrawn: true,
        total_wagered: true,
        total_won: true,
        available_balance: true,
      },
    }),
    db.packs.aggregate({
      _sum: {
        total_openings: true,
        total_revenue: true,
        total_payout: true,
      },
      _avg: { actual_house_edge: true },
    }),
    // Daily wager + deposit series for the last 30 days in ONE ledger
    // scan (was two separate 30-day scans). packs/battles feed the stacked
    // wager bar chart; deposits feeds the deposits line. Split apart in JS
    // below. Pure deposits only (deposit_bonus excluded by the type list).
    db.$queryRaw<{ date: Date; packs: string; battles: string; deposits: string }[]>`
      SELECT
        DATE(created_at) as date,
        COALESCE(SUM(CASE WHEN type = 'pack_opening' THEN ABS(amount::numeric) ELSE 0 END), 0)::text as packs,
        COALESCE(SUM(CASE WHEN type IN ('battle_bet','battle_sponsorship') THEN ABS(amount::numeric) ELSE 0 END), 0)::text as battles,
        COALESCE(SUM(CASE WHEN type = 'deposit' THEN amount::numeric ELSE 0 END), 0)::text as deposits
      FROM ledger_transactions
      WHERE type IN ('pack_opening','battle_bet','battle_sponsorship','deposit') AND status = 'completed'
        AND created_at >= NOW() - INTERVAL '30 days'
        AND user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin', 'support') ${Prisma.raw(blacklistIdNotIn)})
      GROUP BY DATE(created_at)
      ORDER BY date
    `,
    // Signups last 30 days
    db.$queryRaw<{ date: Date; count: string }[]>`
      SELECT DATE(created_at) as date, COUNT(*)::text as count
      FROM "user"
      WHERE created_at >= NOW() - INTERVAL '30 days'
        AND role NOT IN ('admin', 'support') ${Prisma.raw(blacklistIdNotIn)}
      GROUP BY DATE(created_at)
      ORDER BY date
    `,
    // Single batched query replaces 20 independent aggregates (revenue, withdrawal,
    // wager, ggr × 5 periods each). Same plan + same index scan — but one round-trip.
    // 5th arg is the 24h cutoff — pass `rolling24h` (now − 24h), not
    // `startOfDay`. The old behaviour reset every "24h" KPI to zero at
    // UTC midnight, which read like a partial half-day for most of the
    // morning; rolling matches the 1h / 3h / 12h chips on the same card.
    getPeriodAggregates(db, oneHourAgo, threeHoursAgo, sixHoursAgo, twelveHoursAgo, rolling24h, threeDaysAgo, sevenDaysAgo, thirtyDaysAgo, blacklistIdNotIn, sessionWindowsCte),
    db.user_statistics.aggregate({
      where: { user: staffRelation },
      _sum: { opened_packs_count: true, battles_played: true },
    }),
    // Distinct depositor count — # of unique real users who have
    // completed at least one deposit. Powers the dashboard's
    // "Depositors" KPI. Raw SQL with COUNT(DISTINCT) avoids
    // materializing per-user rows; same staff-exclusion as everything
    // else.
    // Distinct depositors = real users whose LIFETIME completed-deposit
    // total is > 0. Read from `balances` (one row per user — thousands)
    // with the same staff+blacklist exclusion, instead of COUNT(DISTINCT
    // user_id) over every completed deposit ledger row (millions). Safe
    // equivalence: total_deposited is the authoritative lifetime deposit
    // sum the dashboard already trusts (avgDeposit / totalDeposited).
    db.balances.count({
      where: { total_deposited: { gt: 0 }, user: staffRelation },
    }),
    getRealizedPnlSnapshot(),
    // Rolling past-24h house P&L — windowed delta (deposits −
    // withdrawals − balanceΔ − inventoryΔ − voucherΔ over the last 24h),
    // distinct from the lifetime realized snapshot above. Same staff +
    // blacklist exclusion as the rest of the dashboard.
    calculateWindowedPnl({ since: rolling24h, excludeUserIds: excluded }),
    db.user_inventory.aggregate({
      where: {
        sold_at: null,
        exchanged_at: null,
        // Exclude items that are locked for a pending card withdrawal —
        // they are effectively "on their way out" of the user's on-site
        // holdings and shouldn't inflate the aggregate balance.
        withdrawal_locked_at: null,
        user: staffRelation,
      },
      _sum: { value_at_obtained: true },
    }),
    // Rolling-24h pack opening count for the "24h Activity" tile.
    // Filter game_sessions by game_type='pack' to match the same
    // definition the existing pack profitability queries use.
    db.game_sessions.count({
      where: {
        game_type: "pack",
        created_at: { gte: rolling24h },
        user: staffRelation,
      },
    }),
    // Rolling-24h battle count — counts battles created in the last 24h
    // regardless of status (started = counts as "happened today").
    // `user` on battles points to the battle creator; that's the row we
    // exclude staff/blacklist on (matching the staff-exclusion in every
    // other dashboard aggregate).
    db.battles.count({
      where: {
        created_at: { gte: rolling24h },
        user: staffRelation,
      },
    }),
    // Rolling-24h signup count — real users created in the last 24h.
    // Pairs with packsOpened24h / battlesPlayed24h for the Recent
    // Activity stats strip. staffRoleDirect (filter directly on the
    // user table) matches the usersToday / Week / Month counts above.
    db.user.count({
      where: { ...staffRoleDirect, created_at: { gte: rolling24h } },
    }),
    // Rolling-24h FTDs — first-time depositors. Each real user's
    // earliest completed deposit (DISTINCT ON … ORDER BY created_at) is
    // their "FTD"; we keep those whose first deposit landed in the last
    // 24h and return BOTH the headcount and the summed first-deposit
    // value (so the dashboard tile can show total + average alongside
    // the count). A user depositing again today after an older deposit
    // is NOT an FTD — only the very first deposit counts. Same "first
    // deposit" definition the fraud scorer uses.
    db.$queryRaw<{ count: string; total: string }[]>`
      WITH first_deposits AS (
        SELECT DISTINCT ON (user_id)
          user_id, amount::numeric AS amount, created_at
        FROM ledger_transactions
        WHERE type = 'deposit' AND status = 'completed'
          AND user_id IN (
            SELECT id FROM "user"
            WHERE role NOT IN ('admin', 'support') ${Prisma.raw(blacklistIdNotIn)}
          )
        ORDER BY user_id, created_at ASC
      )
      SELECT
        COUNT(*)::text AS count,
        COALESCE(SUM(amount), 0)::text AS total
      FROM first_deposits
      WHERE created_at >= ${rolling24h}
    `,
    // Withdrawals queued for payout — requests still in the pipeline
    // (status pending / processing / shipped, i.e. money committed to leave
    // the house but not yet finalized). Mirrors the source-of-truth used by
    // the rest of the dashboard's withdrawal figures (card_withdrawal_requests)
    // and the same status set the avg-session query treats as "in flight".
    // We deliberately count pending+processing+shipped (NOT completed —
    // those already left) so the tile reads as the operator's outstanding
    // payout queue. Real users only (staff + blacklist excluded), matching
    // every other dashboard aggregate. House-POV: a queued payout is a
    // house outflow → rose tile.
    db.$queryRaw<{ count: string; total: string }[]>`
      SELECT
        COUNT(*)::text AS count,
        COALESCE(SUM(total_value_usd::numeric), 0)::text AS total
      FROM card_withdrawal_requests
      WHERE status IN ('pending', 'processing', 'shipped')
        AND user_id IN (
          SELECT id FROM "user"
          WHERE role NOT IN ('admin', 'support') ${Prisma.raw(blacklistIdNotIn)}
        )
    `,
    // Daily FTDs (first-time depositors) for the last 30 days — the daily
    // counterpart to the FTDs (24h) tile and the Signups chart. Uses the
    // SAME "first deposit" definition (DISTINCT ON user_id → each user's
    // earliest completed deposit), bucketed by the day that first deposit
    // landed. Returns per-day count + summed first-deposit value so the
    // chart hover can show count, total, and average. Appended last so the
    // positional destructuring above is unaffected.
    db.$queryRaw<{ date: Date; count: string; total: string }[]>`
      WITH first_deposits AS (
        SELECT DISTINCT ON (user_id)
          user_id, amount::numeric AS amount, created_at
        FROM ledger_transactions
        WHERE type = 'deposit' AND status = 'completed'
          AND user_id IN (
            SELECT id FROM "user"
            WHERE role NOT IN ('admin', 'support') ${Prisma.raw(blacklistIdNotIn)}
          )
        ORDER BY user_id, created_at ASC
      )
      SELECT
        DATE(created_at) AS date,
        COUNT(*)::text AS count,
        COALESCE(SUM(amount), 0)::text AS total
      FROM first_deposits
      WHERE created_at >= NOW() - INTERVAL '30 days'
      GROUP BY DATE(created_at)
      ORDER BY date
    `,
    // Daily Active Depositors — distinct USERS who completed at least
    // one deposit on each day in the last 30 days. A user with three
    // deposits the same day still counts once. Same staff + blacklist
    // exclusion as the rest of the dashboard.
    db.$queryRaw<{ date: Date; count: string }[]>`
      SELECT DATE(created_at) AS date,
             COUNT(DISTINCT user_id)::text AS count
      FROM ledger_transactions
      WHERE type = 'deposit'
        AND status = 'completed'
        AND created_at >= NOW() - INTERVAL '30 days'
        AND user_id IN (
          SELECT id FROM "user"
          WHERE role NOT IN ('admin', 'support') ${Prisma.raw(blacklistIdNotIn)}
        )
      GROUP BY DATE(created_at)
      ORDER BY date
    `,
  ]);

  const totalWagered = toNumber(balanceAggregates._sum?.total_wagered);
  const totalWon = toNumber(balanceAggregates._sum?.total_won);

  // Unpack the batched period aggregates. Each field is a text-encoded
  // numeric; parseFloat() is sufficient because we're always going
  // through Number coercion anyway downstream.
  const pa = periodAggregates[0] ?? {
    revenue_1h: "0", revenue_3h: "0", revenue_6h: "0", revenue_12h: "0",
    revenue_24h: "0", revenue_3d: "0", revenue_7d: "0", revenue_30d: "0", revenue_all: "0",
    withdrawal_1h: "0", withdrawal_3h: "0", withdrawal_6h: "0", withdrawal_12h: "0",
    withdrawal_24h: "0", withdrawal_3d: "0", withdrawal_7d: "0", withdrawal_30d: "0", withdrawal_all: "0",
    wager_1h: "0", wager_3h: "0", wager_6h: "0", wager_12h: "0",
    wager_24h: "0", wager_3d: "0", wager_7d: "0", wager_30d: "0", wager_all: "0",
    wager_excl_session_1h: "0", wager_excl_session_3h: "0", wager_excl_session_6h: "0", wager_excl_session_12h: "0",
    wager_excl_session_24h: "0", wager_excl_session_3d: "0", wager_excl_session_7d: "0", wager_excl_session_30d: "0", wager_excl_session_all: "0",
    ggr_1h: "0", ggr_3h: "0", ggr_6h: "0", ggr_12h: "0",
    ggr_24h: "0", ggr_3d: "0", ggr_7d: "0", ggr_30d: "0", ggr_all: "0",
    deposit_count_1h: "0", deposit_count_3h: "0", deposit_count_6h: "0", deposit_count_12h: "0",
    deposit_count_24h: "0", deposit_count_3d: "0", deposit_count_7d: "0", deposit_count_30d: "0", deposit_count_all: "0",
    active_users_24h: "0",
  };
  const num = (s: string) => parseFloat(s) || 0;
  // Lifetime deposit transaction count — reused from the period
  // aggregates CTE (column `deposit_count_all`) so we don't pay a
  // dedicated `ledger_transactions.count()` round-trip just for this.
  const depositCount = num(pa.deposit_count_all);
  // FTD headcount + summed first-deposit value for the rolling 24h.
  // Average is derived (total / count) — mirrors how avgDeposit is
  // computed below, and avoids a NaN when there are zero FTDs.
  const ftdCount = Number(ftdResult[0]?.count ?? 0);
  const ftdTotal = Number(ftdResult[0]?.total ?? 0);
  // Outstanding withdrawal queue (pending + processing + shipped) — count
  // and summed USD value. Drives the "Pending Payouts" ops tile.
  const pendingWithdrawalsCount = Number(pendingWithdrawalsResult[0]?.count ?? 0);
  const pendingWithdrawalsValue = Number(pendingWithdrawalsResult[0]?.total ?? 0);

  return {
    users: {
      total: Number(userCounts[0]?.total ?? 0),
      today: Number(userCounts[0]?.today ?? 0),
      week: Number(userCounts[0]?.week ?? 0),
      month: Number(userCounts[0]?.month ?? 0),
    },
    // Gaming margin (wagers − payouts) per period. Pure GGR, no liability
    // adjustment. Use realizedPnl for the balance-sheet-true number.
    ggr: {
      "1h": num(pa.ggr_1h),
      "3h": num(pa.ggr_3h),
      "6h": num(pa.ggr_6h),
      "12h": num(pa.ggr_12h),
      "24h": num(pa.ggr_24h),
      "3d": num(pa.ggr_3d),
      "7d": num(pa.ggr_7d),
      "30d": num(pa.ggr_30d),
      all: num(pa.ggr_all),
    },
    // Lifetime realized P&L from the house perspective — see getRealizedPnlSnapshot.
    // This is a single snapshot value, not a period series.
    realizedPnl: realizedPnlResult.pnl,
    // Rolling past-24h house P&L (windowed delta — see calculateWindowedPnl).
    realizedPnl24h: realizedPnl24hResult.pnl,
    deposits: {
      "1h": num(pa.revenue_1h),
      "3h": num(pa.revenue_3h),
      "6h": num(pa.revenue_6h),
      "12h": num(pa.revenue_12h),
      "24h": num(pa.revenue_24h),
      "3d": num(pa.revenue_3d),
      "7d": num(pa.revenue_7d),
      "30d": num(pa.revenue_30d),
      all: num(pa.revenue_all),
    },
    // Deposit COUNT (number of completed deposit transactions) per
    // period. Same window definitions as `deposits` above — they pair
    // 1:1 so the Deposits KPI card can show "$X across N deposits"
    // synced to a single period selector.
    depositCounts: {
      "1h": num(pa.deposit_count_1h),
      "3h": num(pa.deposit_count_3h),
      "6h": num(pa.deposit_count_6h),
      "12h": num(pa.deposit_count_12h),
      "24h": num(pa.deposit_count_24h),
      "3d": num(pa.deposit_count_3d),
      "7d": num(pa.deposit_count_7d),
      "30d": num(pa.deposit_count_30d),
      all: num(pa.deposit_count_all),
    },
    // Sourced from card_withdrawal_requests (status IN completed/shipped)
    // so the StatCard matches the PnL formula. Values are already positive
    // outflow magnitudes; Math.abs is a defensive no-op.
    withdrawals: {
      "1h": Math.abs(num(pa.withdrawal_1h)),
      "3h": Math.abs(num(pa.withdrawal_3h)),
      "6h": Math.abs(num(pa.withdrawal_6h)),
      "12h": Math.abs(num(pa.withdrawal_12h)),
      "24h": Math.abs(num(pa.withdrawal_24h)),
      "3d": Math.abs(num(pa.withdrawal_3d)),
      "7d": Math.abs(num(pa.withdrawal_7d)),
      "30d": Math.abs(num(pa.withdrawal_30d)),
      all: Math.abs(num(pa.withdrawal_all)),
    },
    // Customer wager — wagers a creator made while live on a deal/stream
    // are EXCLUDED (house-funded "sponsored" play, not a real customer
    // bet). A creator's off-session personal play is kept. This is the
    // figure the dashboard's "Total Wager" card shows.
    wagers: {
      "1h": Math.abs(num(pa.wager_excl_session_1h)),
      "3h": Math.abs(num(pa.wager_excl_session_3h)),
      "6h": Math.abs(num(pa.wager_excl_session_6h)),
      "12h": Math.abs(num(pa.wager_excl_session_12h)),
      "24h": Math.abs(num(pa.wager_excl_session_24h)),
      "3d": Math.abs(num(pa.wager_excl_session_3d)),
      "7d": Math.abs(num(pa.wager_excl_session_7d)),
      "30d": Math.abs(num(pa.wager_excl_session_30d)),
      all: Math.abs(num(pa.wager_excl_session_all)),
    },
    // Raw wager — every non-staff user, INCLUDING creators' on-stream
    // sponsored play. The "Raw Wager" card shows this; (wagersRaw −
    // wagers) is the creator deal/stream sponsored-balance contribution.
    wagersRaw: {
      "1h": Math.abs(num(pa.wager_1h)),
      "3h": Math.abs(num(pa.wager_3h)),
      "6h": Math.abs(num(pa.wager_6h)),
      "12h": Math.abs(num(pa.wager_12h)),
      "24h": Math.abs(num(pa.wager_24h)),
      "3d": Math.abs(num(pa.wager_3d)),
      "7d": Math.abs(num(pa.wager_7d)),
      "30d": Math.abs(num(pa.wager_30d)),
      all: Math.abs(num(pa.wager_all)),
    },
    financials: {
      totalDeposited: toNumber(balanceAggregates._sum?.total_deposited),
      totalWithdrawn: toNumber(balanceAggregates._sum?.total_withdrawn),
      totalWagered,
      totalWon,
      // `available_balance` lives on the merged balanceAggregates row
      // (was a second `.aggregate()` call previously — folded into one
      // round-trip during the 2026-05-11 perf pass).
      totalSiteBalance: toNumber(balanceAggregates._sum?.available_balance),
      totalInventoryValue: toNumber(totalInventoryValue._sum?.value_at_obtained),
      // Outstanding (unclaimed) voucher liability — the third leg of the
      // house's balance liability alongside on-site cash + held inventory.
      // Pulled from the realized-P&L snapshot (already fetched + React-
      // cached above), so this adds no extra round-trip and uses the SAME
      // staff+blacklist exclusion. The dashboard previously surfaced only
      // cash + inventory in "Users Total Balance"; vouchers were tracked
      // inside realizedPnl but never shown as part of the liability total.
      totalUnclaimedVouchers: realizedPnlResult.vouchers,
      avgDeposit:
        depositCount > 0
          ? toNumber(balanceAggregates._sum?.total_deposited) / depositCount
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
    packs: {
      totalOpenings: Number(packStats._sum.total_openings ?? 0),
      totalRevenue: toNumber(packStats._sum.total_revenue),
      totalPayout: toNumber(packStats._sum.total_payout),
      avgHouseEdge: toNumber(packStats._avg.actual_house_edge),
    },
    activity: {
      totalPacksOpened: Number(activityTotals._sum?.opened_packs_count ?? 0),
      totalBattlesPlayed: Number(activityTotals._sum?.battles_played ?? 0),
      // Rolling 24h counts — drive the Recent Activity stats strip.
      // Real users only; admins / support / blacklisted accounts excluded.
      packsOpened24h,
      battlesPlayed24h,
      signups24h,
      // Distinct real users who wagered in the last 24h (engagement
      // headcount, from the period-aggregates CTE).
      activeUsers24h: num(pa.active_users_24h),
    },
    // Operational / ops-desk figures that aren't revenue but need an eye
    // on them. Currently the outstanding withdrawal payout queue.
    operations: {
      // Withdrawal requests still in flight (pending / processing /
      // shipped) — count + summed USD value. A queued payout is committed
      // house outflow, so the tile reads House-POV rose.
      pendingWithdrawalsCount,
      pendingWithdrawalsValue,
    },
    dailyWagers: dailyChart.map((d) => ({
      date: new Date(d.date).toISOString().split("T")[0],
      packs: Number(d.packs),
      battles: Number(d.battles),
    })),
    dailyDeposits: dailyChart.map((d) => ({
      date: new Date(d.date).toISOString().split("T")[0],
      amount: Math.abs(Number(d.deposits)),
    })),
    dailySignups: dailySignups.map((d) => ({
      date: new Date(d.date).toISOString().split("T")[0],
      count: Number(d.count),
    })),
    // Daily FTDs — count + summed first-deposit value per day, plus the
    // derived average (total / count, guarded against div-by-zero). The
    // chart shows count; the hover surfaces total + avg.
    dailyFtds: dailyFtds.map((d) => {
      const count = Number(d.count);
      const total = Number(d.total);
      return {
        date: new Date(d.date).toISOString().split("T")[0],
        count,
        total,
        avg: count > 0 ? total / count : 0,
      };
    }),
    // Daily Active Depositors — distinct users who deposited each day
    // in the last 30 days. Drives the matching chart in the Trends row.
    dailyActiveDepositors: dailyActiveDepositors.map((d) => ({
      date: new Date(d.date).toISOString().split("T")[0],
      count: Number(d.count),
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
