import { unstable_cache } from "next/cache";
import { queryMainRows } from "@/lib/drizzle-query";
import { toNumber } from "@/lib/utils/decimal";
import { getRealizedPnlSnapshot } from "./_realized-pnl";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "./_blacklist";
import {
  getDailyGamingMetrics,
  upgraderMetrics,
  type MetricWindow,
} from "@/lib/metrics/queries";
import { getMetricsScope } from "@/lib/metrics/scope";
import { GGR_LIFETIME_LOOKBACK_DAYS } from "@/lib/metrics/ggr-window";
import { MS_PER_DAY } from "@/lib/utils/time";

// SQL fragment builder for user_id filtering on the secondary
// `ledger_transactions` display aggregates (pack/battle wager tiles,
// unique-depositor count, daily reward breakdown). SWEPT onto the central
// canonical scope (`@/lib/metrics/scope` `getMetricsScope`): it drops
// staff (admin/support) + the admin-managed blacklist AND — via an inline
// session-window predicate — creator-on-session rows, while KEEPING
// creators' off-session play. Previously this did a BLUNT role drop
// (`role NOT IN ('admin','support','creator')`), excluding all creator
// activity; the central session-window scope is the verified model and
// keeps analytics on the SAME population as the headline GGR/NGR (which
// come from `getDailyGamingMetrics`, also on the central scope). The
// fragment assumes the aggregate's columns are `user_id` / `created_at`
// (the shape of every aggregate this is appended to). Async because the
// session windows are fetched (5-min cached) — see scope.ts.
async function buildExclStaffFrag(): Promise<string> {
  const scope = await getMetricsScope();
  return scope.exclStaffSessionFrag();
}

type Period = "today" | "7d" | "30d" | "90d" | "all";

/**
 * UTC start-of-current-day boundary. The "Today" chip on this page means
 * the CURRENT CALENDAR DAY since midnight UTC, NOT a rolling past-24h
 * window — same convention as `dashboard-today-pnl.ts` / the daily-P&L
 * chart's most-recent bar / `users.today` in dashboard.ts. Anchoring to UTC
 * keeps the figure identical regardless of which region the serverless
 * function runs in.
 */
function utcStartOfDay(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Convert an analytics `Period` to a metric-window `since` Date for the
 * canonical `@/lib/metrics` builders. `all` uses the canonical bounded
 * lifetime lookback. `today` uses the UTC start-of-day boundary;
 * the other windows are rolling N-day from `now` — matching
 * `periodToDateFilter` exactly so the canonical and ledger-aggregate
 * windows agree.
 */
function periodToMetricWindow(period: Period): MetricWindow {
  if (period === "all") {
    return {
      since: new Date(
        Date.now() - GGR_LIFETIME_LOOKBACK_DAYS * MS_PER_DAY,
      ),
    };
  }
  if (period === "today") return { since: utcStartOfDay() };
  const days = parseDays(period);
  return { since: new Date(Date.now() - days * 24 * 60 * 60 * 1000) };
}

function periodToDateFilter(period: Period): string {
  // Values are fixed server-side query structure.
  // `today` binds the boundary as an ISO timestamp literal cast to
  // timestamptz so the window is "since midnight UTC today" (matching
  // `periodToMetricWindow` above), not a rolling 24-hour interval.
  switch (period) {
    case "today":
      return `AND created_at >= '${utcStartOfDay().toISOString()}'::timestamptz`;
    case "7d":
      return "AND created_at >= NOW() - INTERVAL '7 days'";
    case "30d":
      return "AND created_at >= NOW() - INTERVAL '30 days'";
    case "90d":
      return "AND created_at >= NOW() - INTERVAL '90 days'";
    case "all":
      return `AND created_at >= NOW() - INTERVAL '${GGR_LIFETIME_LOOKBACK_DAYS} days'`;
  }
}

/**
 * Bounded since-predicate fragment for the battle queries: emits
 * `{col} >= <boundary>` (no leading AND), with `{col}` as a placeholder
 * for the caller to substitute the table-qualified column name (e.g.
 * `created_at` or `b.created_at`). Empty string for `all`. `today`
 * anchors at midnight UTC of the current calendar day, matching the
 * page's other "today" predicates.
 */
function battleSinceFragment(period: Period): string {
  switch (period) {
    case "today":
      return `{col} >= '${utcStartOfDay().toISOString()}'::timestamptz`;
    case "7d":
    case "30d":
    case "90d":
      return `{col} >= NOW() - INTERVAL '${parseDays(period)} days'`;
    case "all":
      return `{col} >= NOW() - INTERVAL '${GGR_LIFETIME_LOOKBACK_DAYS} days'`;
  }
}

export type BattleModeStats = {
  totalBattles: number;
  byMode: { mode: string; count: number }[];
  bySetting: { setting: string; count: number }[];
  byFormat: { format: string; count: number }[];
  borrowCount: number;
  sponsoredCount: number;
  privateCount: number;
  topBattlePacks: { id: string; name: string; count: number }[];
};

export type PackPopularityStats = {
  topPacks: {
    id: string;
    name: string;
    opensTotal: number;
    opensBorrowed: number;
    opensNormal: number;
  }[];
  topBorrowedPacks: {
    id: string;
    name: string;
    opensBorrowed: number;
    opensTotal: number;
  }[];
};

export type AnalyticsData = {
  ggr: number;
  ngr: number;
  realizedProfit: number;
  realizedProfitBreakdown: {
    totalDeposits: number;
    totalWithdrawals: number;
    userBalance: number;
    inventory: number;
    vouchers: number;
    unclaimedRakeback: number;
  };
  uniqueVisitors: number;
  newSignups: number;
  packWager: number;
  battleWager: number;
  upgraderWager: number;
  packWagerBorrowed: number;
  battleWagerBorrowed: number;
  battleStats: BattleModeStats;
  packStats: PackPopularityStats;
  daily: {
    date: string;
    ggr: number;
    ngr: number;
    packWager: number;
    battleWager: number;
    uniqueVisitors: number;
    newSignups: number;
    avgDeposit: number;
    avgBet: number;
    totalDeposit: number;
    totalBet: number;
    minDeposit: number;
    maxDeposit: number;
    minBet: number;
    maxBet: number;
    rewardRakeback: number;
    rewardSignupPacks: number;
    rewardLeaderboard: number;
    rewardRain: number;
    rewardPromo: number;
    rewardAffiliate: number;
  }[];
};

/**
 * Inner compute for {@link getAnalyticsData} — runs the full ~13-query
 * aggregate bundle. The resolved blacklist is passed in (rather than
 * fetched here) so it participates verbatim in the `unstable_cache` key
 * of the public wrapper below; do not re-fetch it inside.
 */
async function computeAnalyticsData(
  period: Period,
  excluded: string[],
): Promise<AnalyticsData> {
  const dateFilter = periodToDateFilter(period);
  // Per-request blacklist (cached via React cache) → build the staff
  // + blacklist SQL fragment once and re-use across every sub-query
  // below. Same trick `dashboard.ts` uses. EXCL_STAFF_FRAG now comes from
  // the central session-window scope (creators kept, on-session dropped).
  const EXCL_STAFF_FRAG = await buildExclStaffFrag();
  // Inline `AND id NOT IN (...)` for queries that filter directly on
  // the user table (rather than on `user_id IN (subquery)`). Empty
  // string when nothing is blacklisted.
  const blacklistIdNotIn = blacklistNotInClause("id", excluded);
  // Battle metadata uses the same canonical customer population as the money
  // aggregates: staff, creators, and the dynamic blacklist are all excluded.
  const battleCustomerIds = `(SELECT id FROM "user" WHERE role NOT IN ('admin', 'support', 'creator') ${blacklistIdNotIn})`;
  const battleStaffExcl = `user_id IN ${battleCustomerIds}`;
  const battleStaffExclAliased = `b.user_id IN ${battleCustomerIds}`;

  // `today` anchors at midnight UTC of the current calendar day (matching
  // `periodToDateFilter` / `periodToMetricWindow`); the other windows are
  // rolling N-day from `now`. `all` has no date clause.
  const battleSinceClause = battleSinceFragment(period);
  const battleDateWhere =
    battleSinceClause === ""
      ? `WHERE ${battleStaffExcl}`
      : `WHERE ${battleSinceClause.replace(/{col}/g, "created_at")} AND ${battleStaffExcl}`;
  const battleDateWhereAliased =
    battleSinceClause === ""
      ? `WHERE ${battleStaffExclAliased}`
      : `WHERE ${battleSinceClause.replace(/{col}/g, "b.created_at")} AND ${battleStaffExclAliased}`;

  // Canonical gaming-margin metrics come from `@/lib/metrics`: the daily
  // GGR/NGR series (`getDailyGamingMetrics`) and the upgrader figure from
  // `upgrader_games` (`upgraderMetrics`). The headline GGR/NGR are derived
  // as the SUM of the daily canonical series so the daily chart reconciles
  // with the headline by construction (M2 closed). GGR/NGR here are
  // pack/battle gaming margin (inventory-delta payout, card conversions
  // neutral, borrow plays excluded, real-customer scope) — upgrader is NOT
  // in the ledger (UPGRADER_IN_LEDGER=false) so it is reported separately,
  // never summed into GGR (M1 + the upgrader-bug fix).
  const metricWindow = periodToMetricWindow(period);

  const [
    dailyCanonical,
    upgrader,
    aggregates,
    visitors,
    dailyTx,
    dailySignups,
    battleModeRows,
    battleSettingRows,
    battleFlags,
    battleFormatRows,
    topBattlePackRows,
    topPacksRows,
    realizedPnl,
  ] = await Promise.all([
      getDailyGamingMetrics(metricWindow),
      upgraderMetrics(metricWindow),
      queryMainRows<
        {
          pack_wager: string;
          battle_wager: string;
          pack_wager_borrowed: string;
          battle_wager_borrowed: string;
        }[]
      >(`
        SELECT
          COALESCE(SUM(CASE
            WHEN type::text = 'pack_opening'
            THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS pack_wager,
          COALESCE(SUM(CASE
            WHEN type::text IN ('battle_bet', 'battle_sponsorship')
            THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS battle_wager,
          COALESCE(SUM(CASE
            WHEN type::text = 'pack_opening' AND description ILIKE '%borrow%'
            THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS pack_wager_borrowed,
          COALESCE(SUM(CASE
            WHEN type::text = 'battle_bet' AND description ILIKE '%borrow%'
            THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS battle_wager_borrowed
        FROM ledger_transactions
        WHERE status = 'completed' ${dateFilter} ${EXCL_STAFF_FRAG}
      `),
      queryMainRows<{ count: string }[]>(`
        SELECT COUNT(DISTINCT user_id)::text AS count
        FROM ledger_transactions
        WHERE status = 'completed' ${dateFilter} ${EXCL_STAFF_FRAG}
      `),
      queryMainRows<
        {
          date: Date | string;
          pack_wager: string;
          battle_wager: string;
          unique_visitors: string;
          avg_deposit: string;
          avg_bet: string;
          total_deposit: string;
          total_bet: string;
          min_deposit: string;
          max_deposit: string;
          min_bet: string;
          max_bet: string;
          reward_rakeback: string;
          reward_signup_packs: string;
          reward_leaderboard: string;
          reward_rain: string;
          reward_promo: string;
          reward_affiliate: string;
        }[]
      >(`
        SELECT
          DATE(created_at) AS date,
          COALESCE(SUM(CASE
            WHEN type::text = 'pack_opening'
            THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS pack_wager,
          COALESCE(SUM(CASE
            WHEN type::text IN ('battle_bet', 'battle_sponsorship')
            THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS battle_wager,
          COUNT(DISTINCT user_id)::text AS unique_visitors,
          COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY
            CASE WHEN type::text = 'deposit'
              THEN ABS(amount::numeric) END
          ), 0)::text AS avg_deposit,
          COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY
            CASE WHEN type::text IN ('pack_opening', 'battle_bet', 'battle_sponsorship')
              THEN ABS(amount::numeric) END
          ), 0)::text AS avg_bet,
          COALESCE(SUM(CASE
            WHEN type::text = 'deposit'
            THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS total_deposit,
          COALESCE(SUM(CASE
            WHEN type::text IN ('pack_opening', 'battle_bet', 'battle_sponsorship')
            THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS total_bet,
          COALESCE(MIN(CASE
            WHEN type::text = 'deposit'
            THEN ABS(amount::numeric) END), 0)::text AS min_deposit,
          COALESCE(MAX(CASE
            WHEN type::text = 'deposit'
            THEN ABS(amount::numeric) END), 0)::text AS max_deposit,
          COALESCE(MIN(CASE
            WHEN type::text IN ('pack_opening', 'battle_bet', 'battle_sponsorship')
            THEN ABS(amount::numeric) END), 0)::text AS min_bet,
          COALESCE(MAX(CASE
            WHEN type::text IN ('pack_opening', 'battle_bet', 'battle_sponsorship')
            THEN ABS(amount::numeric) END), 0)::text AS max_bet,
          COALESCE(SUM(CASE
            WHEN type::text = 'rakeback_claim'
            THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS reward_rakeback,
          COALESCE(SUM(CASE
            WHEN type::text = 'balance_reward_claim'
            THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS reward_signup_packs,
          COALESCE(SUM(CASE
            WHEN type::text = 'race_prize'
            THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS reward_leaderboard,
          COALESCE(SUM(CASE
            WHEN type::text = 'rain_win'
            THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS reward_rain,
          COALESCE(SUM(CASE
            WHEN type::text = 'promo_code_redeemed'
            THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS reward_promo,
          COALESCE(SUM(CASE
            WHEN type::text = 'affiliate_claim'
            THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS reward_affiliate
        FROM ledger_transactions
        WHERE status = 'completed' ${dateFilter} ${EXCL_STAFF_FRAG}
        GROUP BY DATE(created_at)
        ORDER BY date
      `),
      queryMainRows<{ date: Date | string; count: string }[]>(`
        SELECT DATE(created_at) AS date, COUNT(*)::text AS count
        FROM "user"
        WHERE role NOT IN ('admin', 'support', 'creator') ${blacklistIdNotIn} ${dateFilter}
        GROUP BY DATE(created_at)
        ORDER BY date
      `),
      queryMainRows<{ mode: string; count: string }[]>(`
        SELECT mode::text AS mode, COUNT(*)::text AS count
        FROM battles
        ${battleDateWhere}
        GROUP BY mode
        ORDER BY COUNT(*) DESC
      `),
      queryMainRows<{ setting: string; count: string }[]>(`
        SELECT setting, COUNT(*)::text AS count
        FROM battles, UNNEST(additional_settings) AS setting
        ${battleDateWhere}
        GROUP BY setting
        ORDER BY COUNT(*) DESC
      `),
      queryMainRows<
        {
          total_battles: string;
          borrow_count: string;
          sponsored_count: string;
          private_count: string;
        }[]
      >(`
        SELECT
          COUNT(*)::text AS total_battles,
          COUNT(*) FILTER (WHERE borrow_percentage > 0)::text AS borrow_count,
          COUNT(*) FILTER (WHERE sponsorship_percentage > 0)::text AS sponsored_count,
          COUNT(*) FILTER (WHERE password IS NOT NULL)::text AS private_count
        FROM battles
        ${battleDateWhere}
      `),
      queryMainRows<{ teams: number; players_per_team: number; count: string }[]>(`
        SELECT teams, players_per_team, COUNT(*)::text AS count
        FROM battles
        ${battleDateWhere}
        GROUP BY teams, players_per_team
        ORDER BY COUNT(*) DESC
      `),
      queryMainRows<{ id: string; name: string; count: string }[]>(`
        SELECT p.id::text AS id, p.name AS name, COUNT(*)::text AS count
        FROM battles b
        CROSS JOIN LATERAL UNNEST(b.pack_ids::uuid[]) AS pid
        JOIN packs p ON p.id = pid
        ${battleDateWhereAliased}
        GROUP BY p.id, p.name
        ORDER BY COUNT(*) DESC
        LIMIT 10
      `),
      queryMainRows<
        {
          id: string;
          name: string;
          opens_total: string;
          opens_borrowed: string;
        }[]
      >(`
        SELECT
          p.id::text AS id,
          p.name AS name,
          COUNT(*)::text AS opens_total,
          COUNT(*) FILTER (WHERE lt.description ILIKE '%borrow%')::text AS opens_borrowed
        FROM ledger_transactions lt
        JOIN game_sessions gs ON lt.game_session_id = gs.id AND gs.game_type = 'pack'
        JOIN packs p ON gs.game_id = p.id
        WHERE lt.type::text = 'pack_opening' AND lt.status = 'completed' ${dateFilter.replace(/created_at/g, "lt.created_at")}
          AND lt.user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin', 'support', 'creator') ${blacklistIdNotIn})
        GROUP BY p.id, p.name
        ORDER BY COUNT(*) DESC
        LIMIT 20
      `),
      // Realized P&L is period-independent (balance-sheet snapshot). Uses the
      // shared helper so the number matches the Dashboard page exactly.
      getRealizedPnlSnapshot(),
    ]);

  const agg = aggregates[0];

  // Canonical GGR/NGR (M1/M2/M4): the daily series comes straight from
  // `@/lib/metrics` (inventory-delta gaming payout, card conversions
  // neutral, net-rain NGR, real-customer scope). The HEADLINE is the SUM
  // of that same daily series, so the daily chart reconciles with the
  // headline by construction — the old bug where the daily payout set
  // (3 types) differed from the headline payout set (4 types) is gone.
  const canonicalByDate = new Map(
    dailyCanonical.map((p) => [p.date, p]),
  );
  const ggr = dailyCanonical.reduce((acc, p) => acc + p.ggr, 0);
  const ngr = dailyCanonical.reduce((acc, p) => acc + p.ngr, 0);

  // Merge daily transaction data with daily signups. The headline
  // signups number is just the period sum of dailySignups — derived in
  // JS to avoid a redundant `db.user.count` round-trip with the same
  // filter that already drives this map.
  const signupsMap = new Map(
    dailySignups.map((d) => [
      new Date(d.date).toISOString().split("T")[0],
      Number(d.count),
    ])
  );
  const signups = dailySignups.reduce((acc, d) => acc + Number(d.count), 0);

  const daily = dailyTx.map((d) => {
    const dateStr = new Date(d.date).toISOString().split("T")[0];
    const canon = canonicalByDate.get(dateStr);
    return {
      date: dateStr,
      // Canonical gaming-margin for the day (or 0 if this day had only
      // non-gaming ledger flow). Same definition as the headline.
      ggr: canon?.ggr ?? 0,
      ngr: canon?.ngr ?? 0,
      packWager: toNumber(d.pack_wager),
      battleWager: toNumber(d.battle_wager),
      uniqueVisitors: Number(d.unique_visitors),
      newSignups: signupsMap.get(dateStr) ?? 0,
      avgDeposit: toNumber(d.avg_deposit),
      avgBet: toNumber(d.avg_bet),
      totalDeposit: toNumber(d.total_deposit),
      totalBet: toNumber(d.total_bet),
      minDeposit: toNumber(d.min_deposit),
      maxDeposit: toNumber(d.max_deposit),
      minBet: toNumber(d.min_bet),
      maxBet: toNumber(d.max_bet),
      rewardRakeback: toNumber(d.reward_rakeback),
      rewardSignupPacks: toNumber(d.reward_signup_packs),
      rewardLeaderboard: toNumber(d.reward_leaderboard),
      rewardRain: toNumber(d.reward_rain),
      rewardPromo: toNumber(d.reward_promo),
      rewardAffiliate: toNumber(d.reward_affiliate),
    };
  });

  // Add days that have signups but no transactions
  for (const [dateStr, count] of signupsMap) {
    if (!daily.find((d) => d.date === dateStr)) {
      daily.push({
        date: dateStr,
        ggr: 0,
        ngr: 0,
        packWager: 0,
        battleWager: 0,
        uniqueVisitors: 0,
        newSignups: count,
        avgDeposit: 0,
        avgBet: 0,
        totalDeposit: 0,
        totalBet: 0,
        minDeposit: 0,
        maxDeposit: 0,
        minBet: 0,
        maxBet: 0,
        rewardRakeback: 0,
        rewardSignupPacks: 0,
        rewardLeaderboard: 0,
        rewardRain: 0,
        rewardPromo: 0,
        rewardAffiliate: 0,
      });
    }
  }

  // Add canonical gaming-margin days the ledger day-series missed — e.g. a
  // day where cards from an earlier wager settled into inventory but no
  // ledger row was booked. Without this the daily chart's GGR/NGR would not
  // sum exactly to the headline (which IS the canonical daily sum).
  const dailyDates = new Set(daily.map((d) => d.date));
  for (const p of dailyCanonical) {
    if (!dailyDates.has(p.date)) {
      daily.push({
        date: p.date,
        ggr: p.ggr,
        ngr: p.ngr,
        packWager: 0,
        battleWager: 0,
        uniqueVisitors: 0,
        newSignups: signupsMap.get(p.date) ?? 0,
        avgDeposit: 0,
        avgBet: 0,
        totalDeposit: 0,
        totalBet: 0,
        minDeposit: 0,
        maxDeposit: 0,
        minBet: 0,
        maxBet: 0,
        rewardRakeback: 0,
        rewardSignupPacks: 0,
        rewardLeaderboard: 0,
        rewardRain: 0,
        rewardPromo: 0,
        rewardAffiliate: 0,
      });
      dailyDates.add(p.date);
    }
  }

  daily.sort((a, b) => a.date.localeCompare(b.date));

  return {
    ggr,
    ngr,
    realizedProfit: realizedPnl.pnl,
    realizedProfitBreakdown: {
      totalDeposits: realizedPnl.totalDeposited,
      totalWithdrawals: realizedPnl.totalWithdrawn,
      userBalance: realizedPnl.userBalance,
      inventory: realizedPnl.inventory,
      vouchers: realizedPnl.vouchers,
      unclaimedRakeback: realizedPnl.unclaimedRakeback,
    },
    uniqueVisitors: Number(visitors[0]?.count ?? 0),
    newSignups: signups,
    packWager: toNumber(agg?.pack_wager),
    battleWager: toNumber(agg?.battle_wager),
    // Upgrader volume from the upgrader-native `upgrader_games` table (the
    // canonical source) — NOT ledger `upgrader_bet`. Prod does not write
    // upgrader rows to the ledger, so the ledger figure would be 0/wrong
    // and must never feed GGR. `null` on the pre-upgrader snapshot (no
    // `upgrader_games` table) → 0.
    upgraderWager: upgrader?.wager ?? 0,
    packWagerBorrowed: toNumber(agg?.pack_wager_borrowed),
    battleWagerBorrowed: toNumber(agg?.battle_wager_borrowed),
    battleStats: {
      totalBattles: Number(battleFlags[0]?.total_battles ?? 0),
      byMode: battleModeRows.map((r) => ({ mode: r.mode, count: Number(r.count) })),
      bySetting: battleSettingRows.map((r) => ({
        setting: r.setting,
        count: Number(r.count),
      })),
      byFormat: battleFormatRows.map((r) => ({
        format:
          r.teams === 2 && r.players_per_team === 1
            ? "1v1"
            : Array(Number(r.teams))
                .fill(String(Number(r.players_per_team)))
                .join("v"),
        count: Number(r.count),
      })),
      borrowCount: Number(battleFlags[0]?.borrow_count ?? 0),
      sponsoredCount: Number(battleFlags[0]?.sponsored_count ?? 0),
      privateCount: Number(battleFlags[0]?.private_count ?? 0),
      topBattlePacks: topBattlePackRows.map((r) => ({
        id: r.id,
        name: r.name,
        count: Number(r.count),
      })),
    },
    packStats: {
      topPacks: topPacksRows.map((r) => {
        const total = Number(r.opens_total);
        const borrowed = Number(r.opens_borrowed);
        return {
          id: r.id,
          name: r.name,
          opensTotal: total,
          opensBorrowed: borrowed,
          opensNormal: total - borrowed,
        };
      }),
      topBorrowedPacks: [...topPacksRows]
        .map((r) => ({
          id: r.id,
          name: r.name,
          opensBorrowed: Number(r.opens_borrowed),
          opensTotal: Number(r.opens_total),
        }))
        .filter((p) => p.opensBorrowed > 0)
        .sort((a, b) => b.opensBorrowed - a.opensBorrowed)
        .slice(0, 10),
    },
    daily,
  };
}

/**
 * Cross-request cache for the heavy {@link getAnalyticsData} bundle.
 *
 * `/analytics` polls via `<AutoRefresh intervalMs={300_000} />`, which
 * fires `router.refresh()` every 5 minutes and re-runs the Overview
 * server component for every viewer. Without a shared cache that re-ran
 * the entire ~13-query aggregate bundle (PERCENTILE_CONT medians,
 * multi-day GROUP BY, battle/pack scans, the lifetime realized-P&L
 * snapshot) against the main game DB on every tick. (PRE-FLIGHT audit
 * §6A SEV-1.)
 *
 * Same idiom as the `insights-rewards` helpers (see `_cache.ts` /
 * `creator-withdrawals.ts`): two `unstable_cache` layers — 60s for the
 * finite windows that move as new activity lands, 300s for the `all`
 * lifetime view that barely shifts second-to-second — BOTH keyed on
 * `(period, sortedBlacklist)` so an admin edit to the excluded-users
 * list busts stale aggregates on the next tick (a different blacklist
 * → a different cache key). Logic is byte-for-byte identical to
 * `computeAnalyticsData`; this is perf/consistency only, no number
 * change. The `unstable_cache` key cannot reuse `makeCachedPair` because
 * that helper's key type is the insights `InsightsRewardsPeriod`
 * (24h/3d/90d) which doesn't include the analytics `today` window.
 */
const cachedAnalyticsData = unstable_cache(
  computeAnalyticsData,
  ["analytics-data-v2"],
  { revalidate: 60, tags: ["analytics"] },
);

const cachedAnalyticsDataLifetime = unstable_cache(
  computeAnalyticsData,
  ["analytics-data-lifetime-v2"],
  { revalidate: 300, tags: ["analytics"] },
);

export async function getAnalyticsData(period: Period): Promise<AnalyticsData> {
  const blacklist = await getExcludedUserIds();
  const sorted = [...blacklist].sort();
  return period === "all"
    ? cachedAnalyticsDataLifetime(period, sorted)
    : cachedAnalyticsData(period, sorted);
}

function parseDays(period: Period): number {
  switch (period) {
    case "today":
      return 1;
    case "7d":
      return 7;
    case "30d":
      return 30;
    case "90d":
      return 90;
    case "all":
      return 36500;
  }
}

/**
 * Slim variant of {@link getAnalyticsData} that runs ONLY the battle-
 * mode + pack-popularity aggregates (6 raws). Used by the
 * `/analytics?tab=packs` page, which previously called the full
 * `getAnalyticsData(period)` bundle (11 raws) purely to populate two
 * sections at the top — wasting an analytics-grade Postgres scan
 * (PERCENTILE_CONT, multi-day GROUP BY, …) on every tab render.
 *
 * Returns only `{ battleStats, packStats }` — the two fields the
 * Pack & Battle tab consumes. Same per-request blacklist filter as
 * `getAnalyticsData` so the numbers stay consistent across pages.
 */
async function computePackAndBattleStats(
  period: Period,
  excluded: string[],
): Promise<{ battleStats: BattleModeStats; packStats: PackPopularityStats }> {
  const dateFilter = periodToDateFilter(period);
  const blacklistIdNotIn = blacklistNotInClause("id", excluded);
  const battleCustomerIds = `(SELECT id FROM "user" WHERE role NOT IN ('admin', 'support', 'creator') ${blacklistIdNotIn})`;
  const battleStaffExcl = `user_id IN ${battleCustomerIds}`;
  const battleStaffExclAliased = `b.user_id IN ${battleCustomerIds}`;
  // `today` anchors at midnight UTC of the current calendar day, matching
  // the page's other "today" predicates (see `battleSinceFragment`).
  const battleSinceClause = battleSinceFragment(period);
  const battleDateWhere =
    battleSinceClause === ""
      ? `WHERE ${battleStaffExcl}`
      : `WHERE ${battleSinceClause.replace(/{col}/g, "created_at")} AND ${battleStaffExcl}`;
  const battleDateWhereAliased =
    battleSinceClause === ""
      ? `WHERE ${battleStaffExclAliased}`
      : `WHERE ${battleSinceClause.replace(/{col}/g, "b.created_at")} AND ${battleStaffExclAliased}`;

  const [
    battleModeRows,
    battleSettingRows,
    battleFlags,
    battleFormatRows,
    topBattlePackRows,
    topPacksRows,
  ] = await Promise.all([
    queryMainRows<{ mode: string; count: string }[]>(`
      SELECT mode::text AS mode, COUNT(*)::text AS count
      FROM battles
      ${battleDateWhere}
      GROUP BY mode
      ORDER BY COUNT(*) DESC
    `),
    queryMainRows<{ setting: string; count: string }[]>(`
      SELECT setting, COUNT(*)::text AS count
      FROM battles, UNNEST(additional_settings) AS setting
      ${battleDateWhere}
      GROUP BY setting
      ORDER BY COUNT(*) DESC
    `),
    queryMainRows<{
      total_battles: string;
      borrow_count: string;
      sponsored_count: string;
      private_count: string;
    }[]>(`
      SELECT
        COUNT(*)::text AS total_battles,
        COUNT(*) FILTER (WHERE borrow_percentage > 0)::text AS borrow_count,
        COUNT(*) FILTER (WHERE sponsorship_percentage > 0)::text AS sponsored_count,
        COUNT(*) FILTER (WHERE password IS NOT NULL)::text AS private_count
      FROM battles
      ${battleDateWhere}
    `),
    queryMainRows<{ teams: number; players_per_team: number; count: string }[]>(`
      SELECT teams, players_per_team, COUNT(*)::text AS count
      FROM battles
      ${battleDateWhere}
      GROUP BY teams, players_per_team
      ORDER BY COUNT(*) DESC
    `),
    queryMainRows<{ id: string; name: string; count: string }[]>(`
      SELECT p.id::text AS id, p.name AS name, COUNT(*)::text AS count
      FROM battles b
      CROSS JOIN LATERAL UNNEST(b.pack_ids::uuid[]) AS pid
      JOIN packs p ON p.id = pid
      ${battleDateWhereAliased}
      GROUP BY p.id, p.name
      ORDER BY COUNT(*) DESC
      LIMIT 10
    `),
    queryMainRows<{
      id: string;
      name: string;
      opens_total: string;
      opens_borrowed: string;
    }[]>(`
      SELECT
        p.id::text AS id,
        p.name AS name,
        COUNT(*)::text AS opens_total,
        COUNT(*) FILTER (WHERE lt.description ILIKE '%borrow%')::text AS opens_borrowed
      FROM ledger_transactions lt
      JOIN game_sessions gs ON lt.game_session_id = gs.id AND gs.game_type = 'pack'
      JOIN packs p ON gs.game_id = p.id
      WHERE lt.type::text = 'pack_opening' AND lt.status = 'completed' ${dateFilter.replace(/created_at/g, "lt.created_at")}
        AND lt.user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin', 'support', 'creator') ${blacklistIdNotIn})
      GROUP BY p.id, p.name
      ORDER BY COUNT(*) DESC
      LIMIT 20
    `),
  ]);

  return {
    battleStats: {
      totalBattles: Number(battleFlags[0]?.total_battles ?? 0),
      byMode: battleModeRows.map((r) => ({ mode: r.mode, count: Number(r.count) })),
      bySetting: battleSettingRows.map((r) => ({
        setting: r.setting,
        count: Number(r.count),
      })),
      byFormat: battleFormatRows.map((r) => ({
        format:
          r.teams === 2 && r.players_per_team === 1
            ? "1v1"
            : Array(Number(r.teams))
                .fill(String(Number(r.players_per_team)))
                .join("v"),
        count: Number(r.count),
      })),
      borrowCount: Number(battleFlags[0]?.borrow_count ?? 0),
      sponsoredCount: Number(battleFlags[0]?.sponsored_count ?? 0),
      privateCount: Number(battleFlags[0]?.private_count ?? 0),
      topBattlePacks: topBattlePackRows.map((r) => ({
        id: r.id,
        name: r.name,
        count: Number(r.count),
      })),
    },
    packStats: {
      topPacks: topPacksRows.map((r) => {
        const total = Number(r.opens_total);
        const borrowed = Number(r.opens_borrowed);
        return {
          id: r.id,
          name: r.name,
          opensTotal: total,
          opensBorrowed: borrowed,
          opensNormal: total - borrowed,
        };
      }),
      topBorrowedPacks: [...topPacksRows]
        .map((r) => ({
          id: r.id,
          name: r.name,
          opensBorrowed: Number(r.opens_borrowed),
          opensTotal: Number(r.opens_total),
        }))
        .filter((p) => p.opensBorrowed > 0)
        .sort((a, b) => b.opensBorrowed - a.opensBorrowed)
        .slice(0, 10),
    },
  };
}

/**
 * Cross-request cache for the slim {@link getPackAndBattleStats} bundle
 * (6 raws), so the `/analytics?tab=packs` view doesn't re-run the
 * battle-mode / pack-popularity scans on every 5-minute `AutoRefresh`
 * tick. Same 60s/300s + `(period, sortedBlacklist)`-keyed pair as
 * {@link getAnalyticsData}; logic identical to `computePackAndBattleStats`.
 */
const cachedPackAndBattleStats = unstable_cache(
  computePackAndBattleStats,
  ["analytics-pack-battle-stats-v2"],
  { revalidate: 60, tags: ["analytics"] },
);

const cachedPackAndBattleStatsLifetime = unstable_cache(
  computePackAndBattleStats,
  ["analytics-pack-battle-stats-lifetime-v2"],
  { revalidate: 300, tags: ["analytics"] },
);

export async function getPackAndBattleStats(
  period: Period,
): Promise<{ battleStats: BattleModeStats; packStats: PackPopularityStats }> {
  const blacklist = await getExcludedUserIds();
  const sorted = [...blacklist].sort();
  return period === "all"
    ? cachedPackAndBattleStatsLifetime(period, sorted)
    : cachedPackAndBattleStats(period, sorted);
}
