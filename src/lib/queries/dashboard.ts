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
} from "@/lib/metrics/queries";
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
 * Convert a dashboard period chip to the canonical `MetricWindow` the
 * `@/lib/metrics` query builders take. The "all" chip maps to
 * `since: null` (true lifetime, no lower bound) rather than the epoch
 * sentinel `periodToCutoff` returns — the canonical layer drops the
 * `created_at >= …` clause entirely for `null`, which is cheaper and
 * semantically exact. Every other chip maps to its rolling cutoff.
 */
function periodToMetricWindow(
  period: DashboardPeriod,
  now: Date,
): MetricWindow {
  return period === "all"
    ? { since: null }
    : { since: periodToCutoff(period, now) };
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
      // Creator-funded slice of the period withdrawal volume — sum +
      // count of card_withdrawal_requests where the requesting user
      // holds role = 'creator' (their personal cash-out, not affiliate
      // payouts). Drives the "Creator Withdrawals" KPI tile so admins
      // can see how much of the period's withdrawal flow is creators
      // pulling their own balance vs ordinary customer cash-outs.
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
        COALESCE(cwr.completed_at, cwr.shipped_at) AS effective_at,
        -- Role of the user who requested the withdrawal — drives the
        -- creator_wd_* aggregates below. JOIN replaces the previous
        -- "user_id IN (SELECT id FROM real_users)" predicate so the
        -- role is carried through to the outer aggregates in a single
        -- scan rather than needing a second sub-query.
        ru.role AS user_role
      FROM card_withdrawal_requests cwr
      JOIN real_users ru ON ru.id = cwr.user_id
      WHERE cwr.status IN ('completed', 'shipped')
    )
    SELECT
      COALESCE(SUM(CASE WHEN type = 'deposit' AND created_at >= ${cutoff} THEN amount ELSE 0 END), 0)::text AS revenue,

      COALESCE((SELECT SUM(CASE WHEN effective_at >= ${cutoff} THEN amount ELSE 0 END) FROM withdrawals), 0)::text AS withdrawal,

      -- Period count of completed/shipped withdrawals — same
      -- withdrawals CTE / effective_at cutoff as the withdrawal amount,
      -- so the count + amount on the Withdrawals KPI card stay
      -- consistent (no separate roundtrip / no source-of-truth split).
      (SELECT COUNT(*) FROM withdrawals WHERE effective_at >= ${cutoff})::text AS withdrawal_count,

      -- Creator-funded slice of the period withdrawal volume — only
      -- card_withdrawal_requests where the requesting user holds
      -- role = 'creator' at query time. Both the sum and the count are
      -- pulled from the same "withdrawals" CTE so the JOIN to "user" /
      -- real_users runs once per period scan.
      COALESCE((SELECT SUM(CASE WHEN effective_at >= ${cutoff} AND user_role = 'creator' THEN amount ELSE 0 END) FROM withdrawals), 0)::text AS creator_wd_amount,
      (SELECT COUNT(*) FROM withdrawals WHERE effective_at >= ${cutoff} AND user_role = 'creator')::text AS creator_wd_count,

      COALESCE(SUM(CASE WHEN type IN ${wagerTypesIn} AND created_at >= ${cutoff} THEN amount ELSE 0 END), 0)::text AS wager,

      -- Customer wager — the wager set MINUS wagers a creator made
      -- while live on a deal/stream (in_session). Creators wager
      -- house-funded "sponsored" balance on stream — recorded as
      -- ordinary pack_opening/battle_bet rows — which is not a real
      -- customer bet. A creator's OFF-session personal play stays in.
      COALESCE(SUM(CASE WHEN type IN ${wagerTypesIn} AND NOT in_session AND created_at >= ${cutoff} THEN amount ELSE 0 END), 0)::text AS wager_excl_session,

      -- Packs / Battles split of the customer GAMEPLAY wager. Same
      -- NOT in_session filter as wager_excl_session, so the two sum
      -- to it. Drives the "Where the wager comes from" chip row under
      -- the Total Wager card. Upgrader is added on top by the caller
      -- from upgrader_games (it is not a ledger wager source).
      COALESCE(SUM(CASE WHEN type = 'pack_opening' AND NOT in_session AND created_at >= ${cutoff} THEN amount ELSE 0 END), 0)::text AS pack_wager_excl_session,
      COALESCE(SUM(CASE WHEN type IN ('battle_bet','battle_sponsorship') AND NOT in_session AND created_at >= ${cutoff} THEN amount ELSE 0 END), 0)::text AS battle_wager_excl_session,

      -- Organic wager — pack / battle gameplay wager from users who
      -- did NOT join under an official creator code (and isn't a
      -- creator's own on-stream play, via NOT in_session). Reads off
      -- the under_creator flag set on the real_users CTE above.
      COALESCE(SUM(CASE WHEN type IN ${wagerTypesIn} AND NOT in_session AND NOT under_creator AND created_at >= ${cutoff} THEN amount ELSE 0 END), 0)::text AS wager_organic,

      -- NOTE: GGR is intentionally NOT computed here anymore. It is
      -- produced by the canonical @/lib/metrics inventory-delta
      -- definition (getWindowMetrics) in dashboardStatsInner. The
      -- previous inline wager minus 19-type payout aggregate folded the
      -- NEUTRAL card/voucher conversions and a phantom ledger
      -- upgrader_payout into the payout side; both are removed.

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
        COALESCE(SUM(CASE WHEN type = 'pack_opening' THEN ABS(amount::numeric) ELSE 0 END), 0)::text as packs,
        COALESCE(SUM(CASE WHEN type IN ('battle_bet','battle_sponsorship') THEN ABS(amount::numeric) ELSE 0 END), 0)::text as battles,
        COALESCE(SUM(CASE WHEN type = 'deposit' THEN amount::numeric ELSE 0 END), 0)::text as deposits,
        COUNT(DISTINCT CASE WHEN type = 'deposit' THEN user_id END)::text as active_depositors
      FROM ledger_transactions
      WHERE type IN ('pack_opening','battle_bet','battle_sponsorship','deposit') AND status = 'completed'
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
        AND lt.type IN ('pack_opening','battle_bet','battle_sponsorship','upgrader_bet')
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
      WHERE type = 'deposit'
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
        COALESCE(SUM(available_balance::numeric), 0)::text AS available_balance
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
    windowMetrics,
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
    // definition: wager (ledger WAGER_TYPES) − (Σ user_inventory win
    // delta + |battle_refund|), with the central real-customer +
    // borrow-corrected scope and upgrader EXCLUDED from the gaming margin
    // (M6 — upgrader has no ledger payout; it is reported via the
    // dedicated Upgrader Stats panel). Replaces the old inline
    // `wager − Σ payout(19)` aggregate. NOT cached — window-dependent.
    withTiming("dashboard.windowMetrics", () =>
      getWindowMetrics({ window: metricWindow }),
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
  // Canonical upgrader wager for the window (from `upgrader_games`), or 0
  // on a pre-upgrader DB. Added to the customer wager DISPLAY tiles as a
  // product line on top of the ledger gameplay wager — it is NOT part of
  // the headline GGR (M6: upgrader has no ledger payout; the gaming
  // margin would be one-legged). Upgrader's own house edge is in the
  // dedicated Upgrader Stats panel.
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
    // up). GGR = wager (ledger WAGER_TYPES) − (Σ `user_inventory` win
    // delta + |battle_refund|), real-customer + borrow-corrected scope.
    // Pure GGR, no liability adjustment — use realizedPnl for the
    // balance-sheet-true number.
    //
    // Upgrader is NOT in this number (M6): upgrader wins live in
    // `upgrader_games`, not the ledger, so there is no ledger
    // `upgrader_payout` to net against `upgrader_bet`. Folding upgrader
    // in would leave a one-legged (wager-only) contribution that
    // overstates house GGR. Upgrader's own margin is surfaced in the
    // dedicated Upgrader Stats panel. The previous inline aggregate that
    // subtracted ledger `upgrader_payout` (and the NEUTRAL card/voucher
    // conversions) on the payout side is removed.
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
    // Creator-funded slice of the same withdrawals figure — the count
    // + dollar amount of card_withdrawal_requests where the requesting
    // user's role is 'creator'. Subset of `withdrawals` above, so the
    // "Creator Withdrawals" tile on the dashboard tracks (count, $) of
    // creator personal cash-outs during the SELECTED period.
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
// `getGgrBreakdown` returns the canonical GGR LEGS for the window:
//   wagers  = ledger WAGER_TYPES (packs + battles), one combined row
//   payouts = pack/battle wins (the `user_inventory.value_at_obtained`
//             delta — the dominant payout, NOT a ledger type) +
//             |battle_refund| (the only ledger cash gaming-payout leg)
//   ggr     = wager − (inventory wins + battle_refund)
//
// `getGgrTopContributors` is the per-user companion using the SAME
// inventory-delta model: per-user wager − (per-user inventory wins +
// per-user |battle_refund|). NOT cached upfront because the per-user
// ledger+inventory join is heavier than the window aggregate; called
// lazily from a server action when the admin opens the expander.
//
// Upgrader is excluded from both (M6 — no ledger upgrader payout; the
// gaming margin would be one-legged). It is surfaced separately via the
// Upgrader Stats panel.
// ============================================================

export type GgrBreakdownRow = {
  /** Display label for the leg (e.g. "pack & battle wager", "battle_refund"). */
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
 * wager side is shown as one combined "pack & battle wager" row; the
 * payout side as two rows — the `user_inventory` win delta (the dominant
 * pack/battle payout) and the `battle_refund` cash leg. Per-ledger-type
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

  const wagers: GgrBreakdownRow[] = [
    { type: "pack & battle wager", total: legs.wager },
  ];
  const payouts: GgrBreakdownRow[] = [
    { type: "pack & battle wins (inventory)", total: legs.inventoryPayout },
    { type: "battle_refund", total: legs.battleRefund },
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
  /** Per-user gaming wager (ledger WAGER_TYPES, borrow-corrected). */
  wagerTotal: number;
  /** Per-user gaming payout (inventory pack/battle wins + |battle_refund|). */
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
 * WAGER_TYPES) − (inventory pack/battle win delta + |battle_refund|),
 * borrow-corrected on both sides. The scope predicate
 * (`role NOT IN ('admin','support','creator')` + blacklist) and the
 * borrow-exclusion subqueries mirror the canonical
 * `@/lib/metrics/queries` `getGamingLegs` / `realCustomersScope` — they
 * are re-expressed here only because that module exposes no per-USER
 * builder (it is window-aggregate only) and must not be edited from the
 * dashboard. The canonical SQL list constants are imported, so the
 * type sets cannot drift from the headline.
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
  const cutoff = periodToCutoff(period, new Date());
  // `null` since = lifetime; mirror the canonical `sinceClause` by
  // dropping the lower bound entirely for the "all" chip.
  const isAll = period === "all";
  const sinceLedger = isAll
    ? Prisma.empty
    : Prisma.sql`AND lt.created_at >= ${cutoff}`;
  const sinceInv = isAll
    ? Prisma.empty
    : Prisma.sql`AND ui.obtained_at >= ${cutoff}`;
  const wagerIn = Prisma.raw(METRICS_WAGER_TYPES_SQL);
  const gamingPayoutIn = Prisma.raw(METRICS_GAMING_PAYOUT_TYPES_SQL);
  // Per-user inventory-delta GGR. Two per-user aggregates merged by
  // user_id:
  //   • ledger leg — wager (Σ|amount| over WAGER_TYPES, borrow-
  //     corrected) + battle_refund (Σ|amount| over GAMING_PAYOUT_TYPES,
  //     the cash winner leg).
  //   • inventory leg — Σ value_at_obtained for source pack/battle,
  //     obtained in window, borrow-corrected (the dominant payout).
  // payout_total = inventory wins + battle_refund; net = wager − payout.
  // Borrow-exclusion subqueries mirror the canonical layer (drop
  // pack opens tagged "borrow" + battle plays on borrow_percentage>0).
  const rows = await db.$queryRaw<
    {
      user_id: string;
      username: string | null;
      wager_total: string;
      payout_total: string;
      net: string;
    }[]
  >`
    WITH real_users AS (
      SELECT u.id, u.username
      FROM "user" u
      WHERE u.role NOT IN ('admin', 'support', 'creator') ${Prisma.raw(blacklistIdNotIn)}
    ),
    non_borrow_pack_sessions AS (
      SELECT game_session_id FROM ledger_transactions
      WHERE type = 'pack_opening' AND status = 'completed'
        AND game_session_id IS NOT NULL
        AND (description IS NULL OR description NOT ILIKE '%borrow%')
    ),
    non_borrow_battle_sessions AS (
      SELECT bp.game_session_id FROM battle_participants bp
      JOIN battles b ON b.id = bp.battle_id
      WHERE COALESCE(b.borrow_percentage, 0) = 0
    ),
    ledger_leg AS (
      SELECT
        lt.user_id,
        COALESCE(SUM(CASE WHEN lt.type IN ${wagerIn}
                          THEN ABS(lt.amount::numeric) ELSE 0 END), 0) AS wager_total,
        COALESCE(SUM(CASE WHEN lt.type IN ${gamingPayoutIn}
                          THEN ABS(lt.amount::numeric) ELSE 0 END), 0) AS battle_refund_total
      FROM ledger_transactions lt
      JOIN real_users ru ON ru.id = lt.user_id
      WHERE lt.status = 'completed'
        ${sinceLedger}
        AND (
          lt.type NOT IN ('pack_opening','battle_bet','battle_sponsorship')
          OR (lt.type = 'pack_opening' AND (lt.description IS NULL OR lt.description NOT ILIKE '%borrow%'))
          OR (lt.type IN ('battle_bet','battle_sponsorship') AND lt.game_session_id IN (SELECT game_session_id FROM non_borrow_battle_sessions))
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
        ${sinceInv}
        AND (
          (ui.source_type = 'pack' AND ui.source_id IN (SELECT game_session_id FROM non_borrow_pack_sessions))
          OR (ui.source_type = 'battle' AND ui.source_id IN (SELECT game_session_id FROM non_borrow_battle_sessions))
        )
      GROUP BY ui.user_id
    ),
    per_user AS (
      SELECT
        ru.id AS user_id,
        ru.username,
        COALESCE(l.wager_total, 0) AS wager_total,
        COALESCE(i.inv_payout, 0) + COALESCE(l.battle_refund_total, 0) AS payout_total
      FROM real_users ru
      LEFT JOIN ledger_leg l ON l.user_id = ru.id
      LEFT JOIN inv_leg i ON i.user_id = ru.id
      WHERE COALESCE(l.wager_total, 0) <> 0
         OR COALESCE(i.inv_payout, 0) <> 0
         OR COALESCE(l.battle_refund_total, 0) <> 0
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
