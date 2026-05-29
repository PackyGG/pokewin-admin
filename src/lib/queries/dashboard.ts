import { cache } from "react";
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
import { getRealizedPnlSnapshot } from "./_realized-pnl";
import { getCreatorSessionWindowsCte } from "./creator-session-windows";
import {
  WAGER_TYPES_SQL,
  PAYOUT_TYPES_SQL,
} from "./_wager-payout-types";
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
 * Single raw query that returns revenue (deposits), withdrawal, wager,
 * GGR, and the windowed-P&L building blocks for the SELECTED period
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
  // GGR wager/payout type sets — built ONCE from the canonical shared
  // constants (src/lib/queries/_wager-payout-types.ts) and interpolated
  // via Prisma.raw, instead of being re-typed inline (where the 19-item
  // payout list inevitably drifts). The values are hardcoded ledger-
  // type strings — no external input — so Prisma.raw is injection-safe.
  const ggrWagerIn = Prisma.raw(WAGER_TYPES_SQL);
  const ggrPayoutIn = Prisma.raw(PAYOUT_TYPES_SQL);
  return db.$queryRaw<
    {
      revenue: string;
      withdrawal: string;
      wager: string;
      // Customer wager — wager MINUS wagers a creator made while live
      // on a deal/stream (house-funded "sponsored" play).
      wager_excl_session: string;
      // Customer wager broken down by source (Packs / Battles /
      // Upgrader). Sum to wager_excl_session.
      pack_wager_excl_session: string;
      battle_wager_excl_session: string;
      upgrader_wager_excl_session: string;
      // Wager from users who did NOT join under an official creator
      // code AND are not creator on-stream play (NOT in_session AND
      // NOT under_creator). Pure organic customer wager.
      wager_organic: string;
      ggr: string;
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
      COALESCE(SUM(CASE WHEN type = 'deposit' AND created_at >= ${cutoff} THEN amount ELSE 0 END), 0)::text AS revenue,

      COALESCE((SELECT SUM(CASE WHEN effective_at >= ${cutoff} THEN amount ELSE 0 END) FROM withdrawals), 0)::text AS withdrawal,

      COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet') AND created_at >= ${cutoff} THEN amount ELSE 0 END), 0)::text AS wager,

      -- Customer wager — the wager set MINUS wagers a creator made
      -- while live on a deal/stream (in_session). Creators wager
      -- house-funded "sponsored" balance on stream — recorded as
      -- ordinary pack_opening/battle_bet rows — which is not a real
      -- customer bet. A creator's OFF-session personal play stays in.
      COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet') AND NOT in_session AND created_at >= ${cutoff} THEN amount ELSE 0 END), 0)::text AS wager_excl_session,

      -- Packs / Battles / Upgrader split of the customer wager. Same
      -- NOT in_session filter as wager_excl_session, so the three sum
      -- to it. Drives the "Where the wager comes from" chip row under
      -- the Total Wager card.
      COALESCE(SUM(CASE WHEN type = 'pack_opening' AND NOT in_session AND created_at >= ${cutoff} THEN amount ELSE 0 END), 0)::text AS pack_wager_excl_session,
      COALESCE(SUM(CASE WHEN type IN ('battle_bet','battle_sponsorship') AND NOT in_session AND created_at >= ${cutoff} THEN amount ELSE 0 END), 0)::text AS battle_wager_excl_session,
      COALESCE(SUM(CASE WHEN type = 'upgrader_bet' AND NOT in_session AND created_at >= ${cutoff} THEN amount ELSE 0 END), 0)::text AS upgrader_wager_excl_session,

      -- Organic wager — pack / battle / upgrader wager from users who
      -- did NOT join under an official creator code (and isn't a
      -- creator's own on-stream play, via NOT in_session). Reads off
      -- the under_creator flag set on the real_users CTE above.
      COALESCE(SUM(CASE WHEN type IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet') AND NOT in_session AND NOT under_creator AND created_at >= ${cutoff} THEN amount ELSE 0 END), 0)::text AS wager_organic,

      -- GGR = wagers − payouts (industry-standard pure gaming margin).
      -- The wager (ggrWagerIn) + payout (ggrPayoutIn) type sets are
      -- interpolated from the canonical shared constants in
      -- src/lib/queries/_wager-payout-types.ts (the same lists
      -- creators-pnl.ts uses), so the dashboard's global GGR can never
      -- drift from the per-creator GGR. Change the lists in that one
      -- file, not here.
      (
        COALESCE(SUM(CASE WHEN type IN ${ggrWagerIn} AND created_at >= ${cutoff} THEN ABS(amount) ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN type IN ${ggrPayoutIn} AND created_at >= ${cutoff} THEN ABS(amount) ELSE 0 END), 0)
      )::text AS ggr,

      -- Deposit COUNT — number of completed deposit transactions in
      -- the selected period. Pairs with revenue so the Deposits
      -- card can show "$X across N deposits".
      COUNT(CASE WHEN type = 'deposit' AND created_at >= ${cutoff} THEN 1 END)::text AS deposit_count,

      -- Windowed balance-change + manual-withdrawal sums for the
      -- windowed P&L figure (was 24h-only, now scoped to the selected
      -- period via the same cutoff). The base CTE is already filtered
      -- to staff+blacklist exclusion and status='completed', so these
      -- are free aggregates off the same scan. balance_after −
      -- balance_before carries the signed delta on every completed
      -- row, so summing across the window gives Δbalance directly.
      COALESCE(SUM(CASE
        WHEN created_at >= ${cutoff}
        THEN (lt_balance_after - lt_balance_before)::numeric ELSE 0 END), 0)::text AS balance_change,
      COALESCE(SUM(CASE
        WHEN type = 'admin_balance_adjustment'
             AND lt_description ILIKE 'Manual withdrawal:%'
             AND lt_balance_after < lt_balance_before
             AND created_at >= ${cutoff}
        THEN amount ELSE 0 END), 0)::text AS manual_wd
    FROM base
  `;
}

// Lifetime realized P&L lives in src/lib/queries/_realized-pnl.ts so the
// Analytics page can use the exact same definition. Do not inline it here.

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

  // Fixed-window cutoffs the period-INDEPENDENT tiles still need:
  //   • rolling24h drives the 24h Activity tile (pack openings + battles
  //     count), FTDs, and one column of lifetimeDepositMetrics.
  //   • sevenDaysAgo drives the 7d column of lifetimeDepositMetrics
  //     (Deposits / hour tile's 7d baseline).
  // The period-bound aggregates use the SELECTED period via the cutoff
  // helper below; we don't precompute the rest of the 9-chip ladder.
  const rolling24h = new Date(now.getTime() - 1 * MS_PER_DAY);
  const sevenDaysAgo = new Date(now.getTime() - 7 * MS_PER_DAY);
  // Cutoff for the SELECTED period — drives every period-bound query
  // (periodAggregates, windowed inventory/voucher delta, etc.). One
  // value, one set of indexed scans — the whole point of the global
  // selector. `new Date(0)` for "all" lets the cutoff filter degrade
  // to a no-op without a special SQL branch.
  const periodCutoff = periodToCutoff(period, now);

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
    dailySignups,
    dailyWagerAttribution,
    periodAggregates,
    uniqueDepositorsResult,
    realizedPnlResult,
    totalInventoryValue,
    packsOpened24h,
    battlesPlayed24h,
    ftdCombined,
    windowedPeriodDelta,
    lifetimeDepositMetrics,
  ] = await Promise.all([
    // All four user counts (total + today/week/month) PLUS the
    // rolling-24h signup count in ONE scan of the user table via
    // COUNT(*) FILTER. The 24h figure used to be a separate user.count
    // call.
    db.$queryRaw<{
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
    // Daily wager + deposit + active-depositor series for the last 30
    // days in ONE ledger scan. packs/battles feed the stacked wager bar
    // chart; deposits feeds the deposits line; active_depositors feeds
    // the Active Depositors chart. The last column used to be its own
    // 30-day ledger scan — merging saves one round-trip + one index
    // scan over the same rows.
    db.$queryRaw<{
      date: Date;
      packs: string;
      battles: string;
      upgrader: string;
      deposits: string;
      active_depositors: string;
    }[]>`
      SELECT
        DATE(created_at) as date,
        COALESCE(SUM(CASE WHEN type = 'pack_opening' THEN ABS(amount::numeric) ELSE 0 END), 0)::text as packs,
        COALESCE(SUM(CASE WHEN type IN ('battle_bet','battle_sponsorship') THEN ABS(amount::numeric) ELSE 0 END), 0)::text as battles,
        COALESCE(SUM(CASE WHEN type = 'upgrader_bet' THEN ABS(amount::numeric) ELSE 0 END), 0)::text as upgrader,
        COALESCE(SUM(CASE WHEN type = 'deposit' THEN amount::numeric ELSE 0 END), 0)::text as deposits,
        COUNT(DISTINCT CASE WHEN type = 'deposit' THEN user_id END)::text as active_depositors
      FROM ledger_transactions
      WHERE type IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet','deposit') AND status = 'completed'
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
    // Daily wager attribution split — organic (no creator-code
    // referral) vs creator-attributed (referred by a creator role
    // user) — for the last 30 days. Excludes the creator role itself
    // and staff from BOTH sides so the two bars represent customer
    // wager only. Stacking organic + creator_attributed = total
    // customer wager.
    db.$queryRaw<{
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
        AND lt.type IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet')
        AND lt.created_at >= NOW() - INTERVAL '30 days'
      GROUP BY DATE(lt.created_at)
      ORDER BY date
    `,
    // Single batched query — computes revenue / withdrawal / wager /
    // ggr / deposit_count / balance_change / manual_wd for the SELECTED
    // period only. Previously this fanned out into 9 windows × many
    // metrics per render; now only the chip the admin clicked gets
    // computed, which is the headline perf win of the period selector.
    // Also produces `balance_change` and `manual_wd` so the windowed
    // P&L no longer needs a separate calculateWindowedPnl() call.
    getPeriodAggregates(db, periodCutoff, blacklistIdNotIn, sessionWindowsCte),
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
    // FTDs combined — rolling-24h figure (count + total) + per-day
    // counts/totals for the last 30 days, sharing a single
    // first_deposits CTE. Previously two separate queries that each
    // re-ran the lifetime DISTINCT ON scan. The UNION ALL keeps the
    // rolling row distinguished by a `tag` column (NULL bucket on the
    // 24h row; one row per day on the 'daily' rows). Same "first
    // deposit" definition the fraud scorer uses.
    db.$queryRaw<{
      tag: string;
      bucket: Date | null;
      count: string;
      total: string;
    }[]>`
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
      SELECT 'rolling24h'::text AS tag,
             NULL::date AS bucket,
             COUNT(*)::text AS count,
             COALESCE(SUM(amount), 0)::text AS total
      FROM first_deposits
      WHERE created_at >= ${rolling24h}
      UNION ALL
      SELECT 'daily'::text AS tag,
             DATE(created_at) AS bucket,
             COUNT(*)::text AS count,
             COALESCE(SUM(amount), 0)::text AS total
      FROM first_deposits
      WHERE created_at >= NOW() - INTERVAL '30 days'
      GROUP BY DATE(created_at)
    `,
    // Windowed inventory + voucher deltas for the SELECTED period.
    // The other three components of the period P&L (deposits, card-
    // withdrawals, ledger balance change, manual withdrawals) already
    // come from periodAggregates / the realized snapshot — these are
    // the two pieces it doesn't carry, so we fetch them in one
    // composite query. Each subselect is a narrow indexed range scan;
    // PG materializes the common `real_users` CTE once.
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
    // Lifetime + 24h + 7d deposit transaction counts in one indexed
    // scan. Cheap (a few-ms count over a single ledger type) and gives
    // us the three fixed-window numbers the period-independent KPI
    // tiles need: lifetime depositCount (drives the Depositors / Avg
    // Deposit math), plus 24h / 7d counts feeding the "Deposits / hr"
    // tile. None of these depend on the selected period.
    db.$queryRaw<{
      lifetime: string;
      h24: string;
      d7: string;
    }[]>`
      SELECT
        COUNT(*)::text AS lifetime,
        COUNT(*) FILTER (WHERE created_at >= ${rolling24h})::text AS h24,
        COUNT(*) FILTER (WHERE created_at >= ${sevenDaysAgo})::text AS d7
      FROM ledger_transactions
      WHERE type = 'deposit'
        AND status = 'completed'
        AND user_id IN (
          SELECT id FROM "user"
          WHERE role NOT IN ('admin', 'support') ${Prisma.raw(blacklistIdNotIn)}
        )
    `,
  ]);

  const totalWagered = toNumber(balanceAggregates._sum?.total_wagered);
  const totalWon = toNumber(balanceAggregates._sum?.total_won);

  // Unpack the batched period aggregates. Each field is a text-encoded
  // numeric; parseFloat() is sufficient because we're always going
  // through Number coercion anyway downstream. Each field is scoped to
  // the SELECTED period via `periodCutoff` — switching the global
  // period selector picks a new cutoff and re-runs this one query.
  const pa = periodAggregates[0] ?? {
    revenue: "0",
    withdrawal: "0",
    wager: "0",
    wager_excl_session: "0",
    pack_wager_excl_session: "0",
    battle_wager_excl_session: "0",
    upgrader_wager_excl_session: "0",
    wager_organic: "0",
    ggr: "0",
    deposit_count: "0",
    balance_change: "0",
    manual_wd: "0",
  };
  const num = (s: string) => parseFloat(s) || 0;
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
  // matches calculateWindowedPnl exactly:
  //   pnl = deposits − (manualWd + cardWd) − balanceChange − Δinv − Δvch
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
    // Gaming margin (wagers − payouts) for the SELECTED period. Pure
    // GGR, no liability adjustment. Use realizedPnl for the balance-
    // sheet-true number.
    ggr: num(pa.ggr),
    // Lifetime realized P&L from the house perspective — see getRealizedPnlSnapshot.
    // This is a single snapshot value, not a period series.
    realizedPnl: realizedPnlResult.pnl,
    // Rolling past-period house P&L (windowed delta — same formula as
    // calculateWindowedPnl but computed inline here from pieces that
    // periodAggregates + the windowedPeriodDelta query already produce).
    // Tracks the selected period via `periodCutoff` instead of being
    // 24h-only — flipping the global chip re-runs this.
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
    // Customer wager — wagers a creator made while live on a deal/
    // stream are EXCLUDED (house-funded "sponsored" play, not a real
    // customer bet). A creator's off-session personal play is kept.
    // This is the figure the dashboard's "Total Wager" card shows.
    wagers: Math.abs(num(pa.wager_excl_session)),
    // Per-source breakdown of the customer wager. Packs + Battles +
    // Upgrader add up to `wagers`. All three sourced from the same
    // NOT in_session filter as wager_excl_session.
    wagersBreakdown: {
      packs: Math.abs(num(pa.pack_wager_excl_session)),
      battles: Math.abs(num(pa.battle_wager_excl_session)),
      upgrader: Math.abs(num(pa.upgrader_wager_excl_session)),
    },
    // Organic wager — customer wager from users who did NOT join
    // under an official creator code (referrer null or non-creator).
    // Excludes creator on-stream play via the same NOT in_session
    // filter as `wagers`. Surfaces volume not attributed to creator
    // marketing.
    wagersOrganic: Math.abs(num(pa.wager_organic)),
    // Raw wager — every non-staff user, INCLUDING creators' on-stream
    // sponsored play. The "Raw Wager" card shows this; (wagersRaw −
    // wagers) is the creator deal/stream sponsored-balance
    // contribution.
    wagersRaw: Math.abs(num(pa.wager)),
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
    activity: {
      // Rolling 24h counts — drive the Recent Activity stats strip.
      // Real users only; admins / support / blacklisted accounts excluded.
      // signups24h now comes from the merged userCounts query (one
      // user-table scan instead of two).
      packsOpened24h,
      battlesPlayed24h,
      signups24h: Number(userCounts[0]?.rolling24h ?? 0),
    },
    dailyWagers: dailyChart.map((d) => ({
      date: new Date(d.date).toISOString().split("T")[0],
      packs: Number(d.packs),
      battles: Number(d.battles),
      upgrader: Number(d.upgrader),
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
