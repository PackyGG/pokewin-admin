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
import {
  WAGER_TYPES_SQL,
  GGR_PAYOUT_TYPES_SQL,
  BONUS_PAYOUT_TYPES_SQL,
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
  // GGR wager / payout / bonus type sets — built ONCE from the canonical
  // shared constants (src/lib/queries/_wager-payout-types.ts) and
  // interpolated via Prisma.raw. The values are hardcoded ledger-type
  // strings — no external input — so Prisma.raw is injection-safe.
  //
  // Two payout sides are interpolated because the dashboard reports
  // both GGR (wagers − gaming payouts) and the bonus-cost drag that
  // turns GGR into NGR (industry-standard: GGR − bonus / promo costs).
  // Merging the two — the old behaviour — surfaced a "GGR" headline
  // that dragged negative whenever bonus volume spiked even if pure
  // gaming margin was positive.
  const ggrWagerIn = Prisma.raw(WAGER_TYPES_SQL);
  const ggrPayoutIn = Prisma.raw(GGR_PAYOUT_TYPES_SQL);
  const bonusPayoutIn = Prisma.raw(BONUS_PAYOUT_TYPES_SQL);
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
      // Bonus / promo / rakeback / voucher costs in the window —
      // payouts that fall outside pure gaming (rain wins, deposit
      // bonuses, gift / promo redemptions, rakeback / affiliate
      // claims, race / waitlist prizes, creator tips, voucher
      // exchanges). NOT subtracted from GGR; surfaced separately so
      // the dashboard can show NGR (GGR − bonus_cost) alongside.
      bonus_cost: string;
      // NGR — net gaming revenue, i.e. GGR after bonus / promo costs.
      // Computed in SQL as `ggr − bonus_cost` so the two numbers stay
      // mathematically consistent (callers can also derive it client-
      // side from the two returned fields).
      ngr: string;
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

      -- Creator-funded slice of the period withdrawal volume — only
      -- card_withdrawal_requests where the requesting user holds
      -- role = 'creator' at query time. Both the sum and the count are
      -- pulled from the same "withdrawals" CTE so the JOIN to "user" /
      -- real_users runs once per period scan.
      COALESCE((SELECT SUM(CASE WHEN effective_at >= ${cutoff} AND user_role = 'creator' THEN amount ELSE 0 END) FROM withdrawals), 0)::text AS creator_wd_amount,
      (SELECT COUNT(*) FROM withdrawals WHERE effective_at >= ${cutoff} AND user_role = 'creator')::text AS creator_wd_count,

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

      -- GGR = wagers − gaming-side payouts (industry-standard pure
      -- gaming margin). The wager (ggrWagerIn) and gaming-payout
      -- (ggrPayoutIn) type sets are interpolated from the canonical
      -- shared constants in src/lib/queries/_wager-payout-types.ts —
      -- GGR_PAYOUT_TYPES covers battle wins, upgrader cash-outs, and
      -- card / inventory cashouts. Bonus / promo / rakeback / voucher
      -- payouts are intentionally NOT in this aggregate; they drag
      -- NGR (computed below), not GGR.
      --
      -- Upgrader plays ARE represented in the ledger on both sides:
      -- upgrader_bet rows debit the wager (in the WAGER set) and
      -- upgrader_payout rows credit the win (in GGR_PAYOUT_TYPES,
      -- added when Upgrader shipped on packy.gg per commit 696b716).
      -- So this aggregate already captures upgrader on both legs; do
      -- NOT subtract a parallel upgrader_games.won_amount figure on
      -- top of it. A prior correction did exactly that based on a
      -- stale assumption (documented in dashboard-upgrader.ts) that
      -- the backend never wrote upgrader_payout rows; that assumption
      -- was already false by the time the correction landed,
      -- producing a -$150k+ phantom drag on the 24h GGR card.
      (
        COALESCE(SUM(CASE WHEN type IN ${ggrWagerIn} AND created_at >= ${cutoff} THEN ABS(amount) ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN type IN ${ggrPayoutIn} AND created_at >= ${cutoff} THEN ABS(amount) ELSE 0 END), 0)
      )::text AS ggr,

      -- Bonus / promo / rakeback / voucher costs in the window. Sum
      -- of every payout type the house pays out as marketing /
      -- retention / loyalty (NOT gameplay wins). Surfaced as its own
      -- column so the dashboard can render it alongside the headline
      -- numbers — letting admins see how much of the period margin is
      -- being eaten by promo flow rather than chasing it as a
      -- phantom GGR drag. BONUS_PAYOUT_TYPES is the canonical list;
      -- see _wager-payout-types.ts for the full enumeration.
      COALESCE(SUM(CASE WHEN type IN ${bonusPayoutIn} AND created_at >= ${cutoff} THEN ABS(amount) ELSE 0 END), 0)::text AS bonus_cost,

      -- NGR = GGR − bonus / promo costs (industry-standard net
      -- gaming revenue). Computed alongside GGR so the two numbers
      -- stay mathematically consistent (the same wager / payout
      -- scans feed both).
      (
        COALESCE(SUM(CASE WHEN type IN ${ggrWagerIn} AND created_at >= ${cutoff} THEN ABS(amount) ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN type IN ${ggrPayoutIn} AND created_at >= ${cutoff} THEN ABS(amount) ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN type IN ${bonusPayoutIn} AND created_at >= ${cutoff} THEN ABS(amount) ELSE 0 END), 0)
      )::text AS ngr,

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
    return db.$queryRaw<{
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
    `;
  },
  ["dashboard-daily-chart-v1"],
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
    // Signups last 30 days. 5-min cached for the same reason.
    withTiming("dashboard.dailySignups", () => cachedDailySignups(blacklistIdNotIn)),
    // Daily wager attribution split — organic (no creator-code
    // referral) vs creator-attributed. 5-min cached.
    withTiming("dashboard.dailyWagerAttribution", () =>
      cachedDailyWagerAttribution(blacklistIdNotIn),
    ),
    // Single batched query — computes revenue / withdrawal / wager /
    // ggr / deposit_count / balance_change / manual_wd for the SELECTED
    // period only. Previously this fanned out into 9 windows × many
    // metrics per render; now only the chip the admin clicked gets
    // computed, which is the headline perf win of the period selector.
    // Also produces `balance_change` and `manual_wd` so the windowed
    // P&L no longer needs a separate calculateWindowedPnl() call.
    // NOT cached — recomputes every render because the cutoff depends
    // on the selected period.
    withTiming("dashboard.periodAggregates", () =>
      getPeriodAggregates(db, periodCutoff, blacklistIdNotIn, sessionWindowsCte),
    ),
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
    wager: "0",
    wager_excl_session: "0",
    pack_wager_excl_session: "0",
    battle_wager_excl_session: "0",
    upgrader_wager_excl_session: "0",
    wager_organic: "0",
    ggr: "0",
    bonus_cost: "0",
    ngr: "0",
    deposit_count: "0",
    balance_change: "0",
    manual_wd: "0",
    creator_wd_amount: "0",
    creator_wd_count: "0",
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
    // Gaming margin (wagers − gaming-side payouts) for the SELECTED
    // period. Pure GGR, no bonus / promo costs, no liability
    // adjustment. Use realizedPnl for the balance-sheet-true number,
    // `ngr` below for GGR after bonus costs.
    //
    // Upgrader is fully represented in `pa.ggr`: upgrader_bet on the
    // wager side and upgrader_payout in GGR_PAYOUT_TYPES. No
    // additional correction needed; the previous `- upgraderWonPeriod`
    // term was double-subtracting every upgrader payout (see SQL
    // comment above the periodAggregates query).
    ggr: num(pa.ggr),
    // Bonus / promo / rakeback / voucher costs in the SELECTED
    // period. NOT subtracted from `ggr` above (industry-standard
    // separation between gaming margin and promo cost). Folded into
    // `ngr` below for the standard "net gaming revenue" headline.
    // Surfacing this on its own lets admins see promo flow directly
    // rather than chasing it as a phantom GGR drag.
    bonusCost: num(pa.bonus_cost),
    // NGR = GGR − bonus cost. Net Gaming Revenue (industry-standard
    // definition). Computed in SQL so the two numbers stay
    // mathematically consistent. Negative ngr with positive ggr means
    // promo / bonus flow exceeds gaming margin for the window — the
    // signal the previous "everything-in-GGR" formula masked.
    ngr: num(pa.ngr),
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
    // Creator-funded slice of the same withdrawals figure — the count
    // + dollar amount of card_withdrawal_requests where the requesting
    // user's role is 'creator'. Subset of `withdrawals` above, so the
    // "Creator Withdrawals" tile on the dashboard tracks (count, $) of
    // creator personal cash-outs during the SELECTED period.
    creatorWithdrawals: Math.abs(num(pa.creator_wd_amount)),
    creatorWithdrawalsCount: num(pa.creator_wd_count),
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
