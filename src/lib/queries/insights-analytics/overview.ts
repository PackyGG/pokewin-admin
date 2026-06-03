import "server-only";

import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { toNumber } from "@/lib/utils/decimal";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";
import { getCreatorSessionWindowsCte } from "@/lib/queries/creator-session-windows";
// Canonical metric layer — single source of truth for wager / GGR / NGR.
// The previous inline `wager − Σ payout(19)` GGR (which folded the
// NEUTRAL card/voucher conversions and a phantom ledger `upgrader_payout`
// into the payout side, plus a bonus list double-subtracted on top for
// NGR) is gone. GGR/NGR now come from `getWindowMetrics` (headline) and
// `getDailyGamingMetrics` (per-day + the previous-window delta) — the
// inventory-delta model, net-rain NGR, real-customer + borrow-corrected
// scope. They reconcile with /ggr, /dashboard and /insights/cost-breakdown
// by construction. The wager DISPLAY leg below uses the SAME canonical
// WAGER_TYPES set so the Wager tile reconciles with the GGR wager leg.
import { WAGER_TYPES_SQL as METRICS_WAGER_TYPES_SQL } from "@/lib/metrics";
import {
  getWindowMetrics,
  getDailyGamingMetrics,
  type WindowMetrics,
  type DailyGamingMetricPoint,
} from "@/lib/metrics/queries";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import { MS_PER_DAY, MS_PER_MINUTE } from "@/lib/utils/time";
import {
  periodToCutoff,
  previousPeriodCutoff,
  type InsightsPeriod,
} from "@/app/(admin)/insights/analytics/types";

/**
 * Overview tab helper — top-line KPIs for the selected period AND the
 * previous comparable period (for the up/down delta chips), plus a daily
 * series for the sparklines.
 *
 * GGR / NGR are the CANONICAL `@/lib/metrics` figures (inventory-delta
 * gaming payout, card conversions neutral, net-rain NGR, real-customer +
 * borrow-corrected scope). They reconcile with /ggr, /dashboard and
 * /insights/cost-breakdown by construction. The deposits / withdrawals /
 * wager / organic-wager / signups / active aggregates are computed by the
 * window query below (creator on-stream sessions dropped via the same
 * session_windows CTE pnl.ts / dashboard.ts use; staff + manual blacklist
 * excluded everywhere).
 *
 * "Organic wager" = customer gameplay wager from users who did NOT join
 * under an official creator code — replicated from dashboard.ts's
 * `wager_organic` (the `under_creator` flag: referred_by points to a user
 * with role 'creator'; NULL referrer = organic). Creator-coded wager is
 * the complement (`wagerCreatorCoded`).
 */

export type OverviewKpis = {
  current: OverviewWindow;
  previous: OverviewWindow | null;
  daily: OverviewDay[];
};

export type OverviewWindow = {
  deposits: number;
  depositCount: number;
  withdrawals: number;
  wager: number;
  /** Customer wager from users NOT under a creator code (organic). */
  wagerOrganic: number;
  /** Customer wager from users who joined under a creator code. */
  wagerCreatorCoded: number;
  ggr: number;
  ngr: number;
  newSignups: number;
  uniqueActive: number;
};

export type OverviewDay = {
  date: string; // ISO YYYY-MM-DD
  deposits: number;
  withdrawals: number;
  wager: number;
  /** Organic (non-creator-coded) wager booked on the day. */
  wagerOrganic: number;
  /** Creator-coded wager booked on the day. */
  wagerCreatorCoded: number;
  ggr: number;
  ngr: number;
  signups: number;
  active: number;
};

// ─── Per-leg degraded fallbacks ──────────────────────────────────────
//
// The Overview tab fans out into four independent heavy reads (the
// deposits/withdrawals/wager window query, its cached daily series, and
// the two CANONICAL gaming-margin reads `getWindowMetrics` /
// `getDailyGamingMetrics` — full `ledger_transactions` + `user_inventory`
// scans with correlated borrow/reward-pack sub-selects). Previously they
// ran in a bare `Promise.all`, so if ANY one threw or — after the
// safeQuery-timeout migration — exceeded the wall-clock bound, the whole
// `getInsightsOverview` rejected and the tab collapsed to a single
// "Couldn't load this section" tile, discarding the legs that DID succeed.
//
// Each leg is now wrapped in `safeQuery` with the canonical heavy-read
// timeout and a NEUTRAL fallback (all-zero metrics, empty series), exactly
// like `getGgrPageData` in `@/lib/queries/ggr.ts`. A single slow/failed leg
// (in practice the unbounded-lifetime canonical GGR/NGR reads) degrades to
// 0/empty and the REST of the Overview KPIs still render. This is a pure
// resilience change — no metric formula, scope, or query shape is altered;
// the fallbacks are just the empty-state value of each reader's return
// type.

/** Neutral all-zero fallback for the deposits/withdrawals/wager window. */
const EMPTY_RAW_WINDOW_ROW: RawWindowRow = {
  deposits: "0",
  deposit_count: "0",
  withdrawals: "0",
  wager: "0",
  wager_organic: "0",
  wager_creator_coded: "0",
  signups: "0",
  active: "0",
};

const EMPTY_WINDOWS: { current: RawWindowRow; previous: RawWindowRow } = {
  current: EMPTY_RAW_WINDOW_ROW,
  previous: EMPTY_RAW_WINDOW_ROW,
};

/** Neutral all-zero fallback for the canonical window metrics (GGR/NGR). */
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
 * Capped lifetime lookback (days) for the Overview "Lifetime" window.
 *
 * The canonical gaming-margin reads (`getWindowMetrics` /
 * `getDailyGamingMetrics`) take a `MetricWindow.since`; a TRUE unbounded
 * window (`since: null`) makes BOTH scan the entire ~400k-row
 * `ledger_transactions` history plus the full `user_inventory` (and
 * `upgrader_games`) with correlated borrow/reward-pack sub-selects and no
 * lower bound, which blows the per-leg `safeQuery` timeout on prod-sized
 * data — so the leg degrades to $0 and the headline GGR/NGR (or the
 * deposits/wager/signups window) renders empty on Lifetime. So Lifetime is
 * bounded to the SAME capped lookback the rest of the codebase uses for
 * lifetime scans — `/ggr`'s `GGR_LIFETIME_LOOKBACK_DAYS` and the
 * insights-rewards / deposit-bonus `*_LOOKBACK_DAYS`, all 365. The value is
 * duplicated here as a local constant (rather than imported across the
 * unrelated `/ggr` / deposit-bonus surfaces) to keep this module decoupled,
 * the SAME way those modules inline `365` with a reference comment. Keep in
 * sync with that canonical 365-day guard.
 *
 * This is a PERFORMANCE bound, not a metric-truth change: every Overview
 * surface other than the canonical legs already capped its own lifetime
 * horizon (the sparkline at 180d via `sparkSinceForPeriod`; the window
 * query has no lifetime previous-window). Bounding the canonical legs to
 * 365d brings them in line and is the same treatment `/ggr` Lifetime
 * already applies to the IDENTICAL `getWindowMetrics` call.
 */
const OVERVIEW_LIFETIME_LOOKBACK_DAYS = 365;

/**
 * The canonical-metric `since` for the selected period. Finite windows map
 * to their cutoff; Lifetime maps to a BOUNDED `now − 365d` (NOT unbounded
 * `null`) so neither `getWindowMetrics` nor `getDailyGamingMetrics` runs a
 * full-history scan. Mirrors `/ggr`'s `ggrWindowToMetricWindow` for the
 * SAME canonical reads.
 */
function metricSinceForPeriod(period: InsightsPeriod, now: Date): Date {
  if (period !== "lifetime") return periodToCutoff(period, now);
  return new Date(now.getTime() - OVERVIEW_LIFETIME_LOOKBACK_DAYS * MS_PER_DAY);
}

/**
 * Period scopes the cutoff for the current window (and an identical-width
 * prior window for comparisons). Lifetime skips the prior-window
 * comparison and the sparkline horizon is capped at 180d so the query
 * stays bounded.
 *
 * RESILIENCE: each of the four parallel reads is wrapped in `safeQuery`
 * (15s bound, neutral fallback) so this function NEVER throws — a single
 * slow or failing leg degrades to its empty/0 state and the rest of the
 * Overview still renders, instead of one leg propagating through the
 * `Promise.all` and collapsing the whole tab to its error tile. Mirrors
 * the `getGgrPageData` resilience pattern.
 *
 * PERFORMANCE: the two CANONICAL gaming-margin reads (`getWindowMetrics` /
 * `getDailyGamingMetrics`) and the deposits/withdrawals/wager window query
 * are each wrapped in a period-keyed `unstable_cache` (see
 * `cachedWindowMetrics` / `cachedDailyMetrics` / `cachedWindowQuery`
 * below). The first cold load of a window fills the cache; every reload
 * inside the TTL is instant, so a slow cold 30d load no longer
 * re-degrades-to-$0 on each subsequent render. Lifetime is bounded to 365d
 * (`metricSinceForPeriod`) so the canonical reads never do an unbounded
 * scan. NEITHER the cache nor the bound changes any metric formula, scope,
 * or query shape — the cached value is byte-identical to the un-cached
 * read, and the 365d bound is the same one `/ggr` already applies to the
 * identical `getWindowMetrics` call.
 */
export async function getInsightsOverview(
  period: InsightsPeriod,
): Promise<OverviewKpis> {
  // Bucket "now" down to the whole MINUTE before deriving any window
  // cutoff. EVERY window here is "N days/hours back from now", so the
  // derived cutoffs (and the ISO strings handed to the period-keyed
  // `unstable_cache` wrappers below) are otherwise millisecond-precise and
  // change on every render — which would make each cache key UNIQUE and the
  // cache never hit, defeating the whole point of the wrappers. Rounding to
  // the minute makes the cutoff (and thus the key) STABLE for 60s, so
  // reloads inside the TTL share a slot. The value is computed for the SAME
  // bucketed `now`, so key == value exactly (no key/value drift) — and a
  // sub-minute shift of a 24h/30d/lifetime window boundary is immaterial to
  // the aggregate (the same negligible boundary the dashboard's `NOW()`-in-
  // SQL helpers already tolerate between a cache fill and a read).
  const now = new Date(
    Math.floor(Date.now() / MS_PER_MINUTE) * MS_PER_MINUTE,
  );
  const cutoff = periodToCutoff(period, now);
  const previous = previousPeriodCutoff(period, now);
  const excluded = await getExcludedUserIds();
  const blacklistIdNotIn = blacklistNotInClause("id", excluded);
  const sessionWindowsCte = await getCreatorSessionWindowsCte();

  // Canonical metric `since` for the CURRENT period — the EXACT same cutoff
  // the wager tile uses. Lifetime → BOUNDED 365-day lookback (NOT unbounded
  // `null`) so `getWindowMetrics` never runs a full-history scan that blows
  // the per-leg timeout; this is the SAME bound `/ggr` applies to the
  // identical canonical read (`metricSinceForPeriod`). The headline GGR/NGR
  // is the canonical `getWindowMetrics` figure (not a daily re-sum), so the
  // headline reconciles with /ggr, /dashboard and /insights/cost-breakdown
  // to the cent (both now cap Lifetime at 365d, so they agree there too).
  // Reconstructed into a `MetricWindow` inside `cachedWindowMetrics` (the
  // ISO is the serializable cache-key form).
  const metricSince = metricSinceForPeriod(period, now);

  // Canonical daily GGR/NGR series — drives the sparkline merge AND the
  // PREVIOUS-window GGR/NGR delta chip (summed over the prior date range;
  // daily GGR sums to window GGR by construction, the metric layer's own
  // invariant). Lifetime has no previous window so the series only needs
  // the sparkline horizon; windowed periods widen it back to `previous.start`
  // so the entire prior window is in range. The current-window headline does
  // NOT come from this sum — it comes from `getWindowMetrics` above, exact.
  // The sparkline horizon (`sparkSinceForPeriod`) is already capped at 180d
  // for Lifetime, so this `since` is inherently bounded — no unbounded daily
  // scan even on Lifetime.
  const metricsSince = (() => {
    const sparkSince = sparkSinceForPeriod(period, now);
    // Ensure the daily series reaches back far enough to cover the entire
    // previous window (previous.start can predate the sparkline horizon for
    // the longer periods, e.g. 90d → previous starts 180d ago).
    return previous && previous.start < sparkSince ? previous.start : sparkSince;
  })();

  // Each leg wrapped so one failure/timeout degrades only that leg to its
  // neutral fallback (the rest of the KPIs still render). `error` fields are
  // intentionally ignored here — a degraded leg simply shows its 0/empty
  // state inline — but they are still logged inside `safeQuery` with the
  // per-leg context tag for diagnosis. Timeout = the canonical heavy-read
  // bound so a pathological leg degrades well before the platform kills the
  // request.
  const [
    { data: windows },
    { data: daily },
    { data: currentMetrics },
    { data: dailyMetrics },
  ] = await Promise.all([
    safeQuery(
      () =>
        // Period-keyed cache wrapper around the deposits/withdrawals/wager
        // window query. The cutoffs (ISO) AND the scope inputs (blacklist +
        // session-windows CTE) are all in the cache key, so a changed scope
        // can never serve a stale value. Cold first load runs the query;
        // reloads inside the TTL are instant.
        cachedWindowQuery(
          period,
          cutoff.toISOString(),
          previous?.start?.toISOString() ?? null,
          previous?.end?.toISOString() ?? null,
          blacklistIdNotIn,
          sessionWindowsCte,
        ),
      EMPTY_WINDOWS,
      "insights-analytics.overview.window",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () =>
        cachedDailyOverview(
          // sparkline horizon = lifetime caps at 180d, otherwise the full
          // period plus one mirror window so the chart can visually separate
          // "this period" from "last period".
          sparkSinceForPeriod(period, now).toISOString(),
          blacklistIdNotIn,
          sessionWindowsCte,
        ),
      [] as Awaited<ReturnType<typeof cachedDailyOverview>>,
      "insights-analytics.overview.daily",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      // Period-keyed cache wrapper around the CANONICAL `getWindowMetrics`
      // (GGR/NGR). The window `since` (ISO) AND the scope inputs are in the
      // cache key — the cached value is byte-identical to the un-cached
      // canonical read, and the scope inputs guarantee a changed
      // blacklist/session-window set busts it. This does NOT cache or touch
      // the shared `getWindowMetrics` itself (so /ggr + dashboard are
      // unaffected) — it caches THIS page's call of it.
      () =>
        cachedWindowMetrics(
          period,
          metricSince.toISOString(),
          blacklistIdNotIn,
          sessionWindowsCte,
        ),
      EMPTY_WINDOW_METRICS,
      "insights-analytics.overview.windowMetrics",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      // Period-keyed cache wrapper around the CANONICAL
      // `getDailyGamingMetrics` (daily GGR/NGR series). Same contract as
      // `cachedWindowMetrics`: `metricsSince` (ISO) + scope inputs in the
      // key, byte-identical cached value, does NOT touch the shared
      // `getDailyGamingMetrics` itself.
      () =>
        cachedDailyMetrics(
          period,
          metricsSince.toISOString(),
          blacklistIdNotIn,
          sessionWindowsCte,
        ),
      [] as DailyGamingMetricPoint[],
      "insights-analytics.overview.dailyMetrics",
      REWARD_QUERY_TIMEOUT_MS,
    ),
  ]);

  // Daily GGR/NGR keyed by date for both the sparkline merge and the
  // previous-window sum below.
  const ggrByDate = new Map<string, { ggr: number; ngr: number }>();
  for (const p of dailyMetrics) {
    ggrByDate.set(p.date, { ggr: p.ggr, ngr: p.ngr });
  }

  // Sum the canonical daily GGR/NGR over a [start, end) date range — used
  // only for the previous-window delta chip (approximate by day boundary,
  // which is fine for a trend chip; the headline current figure is exact).
  const sumGgrNgr = (
    start: Date,
    end: Date,
  ): { ggr: number; ngr: number } => {
    let ggr = 0;
    let ngr = 0;
    for (const p of dailyMetrics) {
      const d = new Date(`${p.date}T00:00:00.000Z`);
      if (d >= start && d < end) {
        ggr += p.ggr;
        ngr += p.ngr;
      }
    }
    return { ggr, ngr };
  };

  // Current-window GGR/NGR: the exact canonical headline figure.
  const currentGgrNgr = { ggr: currentMetrics.ggr, ngr: currentMetrics.ngr };

  // Previous-window GGR/NGR: only for windowed periods (lifetime has no
  // comparable prior window).
  const previousGgrNgr = previous
    ? sumGgrNgr(previous.start, previous.end)
    : null;

  return {
    current: parseWindow(windows.current, currentGgrNgr.ggr, currentGgrNgr.ngr),
    previous: previous
      ? parseWindow(
          windows.previous,
          previousGgrNgr?.ggr ?? 0,
          previousGgrNgr?.ngr ?? 0,
        )
      : null,
    daily: daily.map((d) => {
      const date = new Date(d.date).toISOString().slice(0, 10);
      const m = ggrByDate.get(date);
      return {
        date,
        deposits: toNumber(d.deposits),
        withdrawals: toNumber(d.withdrawals),
        wager: toNumber(d.wager),
        wagerOrganic: toNumber(d.wager_organic),
        wagerCreatorCoded: toNumber(d.wager_creator_coded),
        ggr: m?.ggr ?? 0,
        ngr: m?.ngr ?? 0,
        signups: Number(d.signups),
        active: Number(d.active),
      };
    }),
  };
}

function sparkSinceForPeriod(period: InsightsPeriod, now: Date): Date {
  // Sparkline horizon matches the selected period for the windowed
  // views, but lifetime caps at 180 days so the query stays bounded.
  // 90d is the longest non-lifetime window we cap at 180d.
  const dayMs = 24 * 60 * 60 * 1000;
  const days = (() => {
    switch (period) {
      case "24h":
        return 7; // 7d series so the 24h sparkline still shows context
      case "3d":
        return 14;
      case "7d":
        return 30;
      case "30d":
        return 60;
      case "90d":
        return 120;
      case "lifetime":
        return 180;
    }
  })();
  return new Date(now.getTime() - days * dayMs);
}

type RawWindowRow = {
  deposits: string;
  deposit_count: string;
  withdrawals: string;
  wager: string;
  wager_organic: string;
  wager_creator_coded: string;
  signups: string;
  active: string;
};

async function runWindowQuery(args: {
  currentCutoff: Date;
  previousStart: Date | null;
  previousEnd: Date | null;
  blacklistIdNotIn: string;
  sessionWindowsCte: string;
}): Promise<{ current: RawWindowRow; previous: RawWindowRow }> {
  const db = await getDb();
  const {
    currentCutoff,
    previousStart,
    previousEnd,
    blacklistIdNotIn,
    sessionWindowsCte,
  } = args;

  // When `previous` is null (lifetime period) we still need a valid
  // SQL range so the columns don't blow up. Default to (epoch, epoch)
  // which yields zero rows in those CASEs, then the consumer
  // discards the `previous` shape entirely.
  const prevStart = previousStart ?? new Date(0);
  const prevEnd = previousEnd ?? new Date(0);

  // Canonical WAGER_TYPES set (packs + battles; no phantom upgrader_bet,
  // no withdrawal_shipping_fee) — the SAME set the headline GGR wager leg
  // uses, so this displayed wager reconciles with the GGR card.
  const wagerIn = Prisma.raw(METRICS_WAGER_TYPES_SQL);

  const rows = await db.$queryRaw<
    {
      window: "current" | "previous";
      deposits: string;
      deposit_count: string;
      withdrawals: string;
      wager: string;
      wager_organic: string;
      wager_creator_coded: string;
      signups: string;
      active: string;
    }[]
  >`
    WITH real_users AS (
      SELECT u.id, u.role, u.created_at AS signup_at,
             -- under_creator flags users who joined under an official
             -- creator code: referred_by points to a user with role
             -- 'creator'. NULL referred_by (organic signup) is false.
             -- Replicated from dashboard.ts's organic-wager attribution.
             EXISTS (
               SELECT 1 FROM "user" ref
               WHERE ref.id = u.referred_by AND ref.role = 'creator'
             ) AS under_creator
      FROM "user" u
      WHERE u.role NOT IN ('admin', 'support') ${Prisma.raw(blacklistIdNotIn)}
    ),
    ${Prisma.raw(sessionWindowsCte)},
    base AS (
      -- Same in_session pattern dashboard.ts uses: a creator wager
      -- placed while live on a deal/stream is house-funded sponsored
      -- play, not a real customer bet — dropped from the wager figure
      -- (NOT in_session) so it matches the GGR card on the dashboard.
      -- under_creator carries forward whether the wagering user joined
      -- under an official creator code (drives the organic split).
      SELECT lt.user_id, lt.type, lt.amount::numeric AS amount, lt.created_at,
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
        COALESCE(cwr.completed_at, cwr.shipped_at) AS effective_at
      FROM card_withdrawal_requests cwr
      JOIN real_users ru ON ru.id = cwr.user_id
      WHERE cwr.status IN ('completed', 'shipped')
    )
    SELECT
      'current'::text AS window,
      COALESCE(SUM(CASE WHEN type::text = 'deposit' AND created_at >= ${currentCutoff} THEN amount ELSE 0 END), 0)::text AS deposits,
      COUNT(CASE WHEN type::text = 'deposit' AND created_at >= ${currentCutoff} THEN 1 END)::text AS deposit_count,
      COALESCE((SELECT SUM(CASE WHEN effective_at >= ${currentCutoff} THEN amount ELSE 0 END) FROM withdrawals), 0)::text AS withdrawals,
      COALESCE(SUM(CASE WHEN type::text IN ${wagerIn} AND NOT in_session AND created_at >= ${currentCutoff} THEN ABS(amount) ELSE 0 END), 0)::text AS wager,
      -- Organic wager — customers NOT under a creator code (NOT
      -- under_creator), excluding creator on-stream play (NOT in_session).
      COALESCE(SUM(CASE WHEN type::text IN ${wagerIn} AND NOT in_session AND NOT under_creator AND created_at >= ${currentCutoff} THEN ABS(amount) ELSE 0 END), 0)::text AS wager_organic,
      -- Creator-coded wager — customers who joined under a creator code.
      COALESCE(SUM(CASE WHEN type::text IN ${wagerIn} AND NOT in_session AND under_creator AND created_at >= ${currentCutoff} THEN ABS(amount) ELSE 0 END), 0)::text AS wager_creator_coded,
      (SELECT COUNT(*)::text FROM real_users WHERE signup_at >= ${currentCutoff}) AS signups,
      COUNT(DISTINCT CASE WHEN created_at >= ${currentCutoff} THEN user_id END)::text AS active
    FROM base
    UNION ALL
    SELECT
      'previous'::text AS window,
      COALESCE(SUM(CASE WHEN type::text = 'deposit' AND created_at >= ${prevStart} AND created_at < ${prevEnd} THEN amount ELSE 0 END), 0)::text AS deposits,
      COUNT(CASE WHEN type::text = 'deposit' AND created_at >= ${prevStart} AND created_at < ${prevEnd} THEN 1 END)::text AS deposit_count,
      COALESCE((SELECT SUM(CASE WHEN effective_at >= ${prevStart} AND effective_at < ${prevEnd} THEN amount ELSE 0 END) FROM withdrawals), 0)::text AS withdrawals,
      COALESCE(SUM(CASE WHEN type::text IN ${wagerIn} AND NOT in_session AND created_at >= ${prevStart} AND created_at < ${prevEnd} THEN ABS(amount) ELSE 0 END), 0)::text AS wager,
      COALESCE(SUM(CASE WHEN type::text IN ${wagerIn} AND NOT in_session AND NOT under_creator AND created_at >= ${prevStart} AND created_at < ${prevEnd} THEN ABS(amount) ELSE 0 END), 0)::text AS wager_organic,
      COALESCE(SUM(CASE WHEN type::text IN ${wagerIn} AND NOT in_session AND under_creator AND created_at >= ${prevStart} AND created_at < ${prevEnd} THEN ABS(amount) ELSE 0 END), 0)::text AS wager_creator_coded,
      (SELECT COUNT(*)::text FROM real_users WHERE signup_at >= ${prevStart} AND signup_at < ${prevEnd}) AS signups,
      COUNT(DISTINCT CASE WHEN created_at >= ${prevStart} AND created_at < ${prevEnd} THEN user_id END)::text AS active
    FROM base
  `;

  const current = rows.find((r) => r.window === "current");
  const prev = rows.find((r) => r.window === "previous");
  if (!current || !prev) {
    throw new Error("insights-analytics: overview window query returned 0 rows");
  }
  return {
    current: {
      deposits: current.deposits,
      deposit_count: current.deposit_count,
      withdrawals: current.withdrawals,
      wager: current.wager,
      wager_organic: current.wager_organic,
      wager_creator_coded: current.wager_creator_coded,
      signups: current.signups,
      active: current.active,
    },
    previous: {
      deposits: prev.deposits,
      deposit_count: prev.deposit_count,
      withdrawals: prev.withdrawals,
      wager: prev.wager,
      wager_organic: prev.wager_organic,
      wager_creator_coded: prev.wager_creator_coded,
      signups: prev.signups,
      active: prev.active,
    },
  };
}

/**
 * Period-keyed `unstable_cache` wrapper around `runWindowQuery` (the
 * deposits/withdrawals/wager/organic/signups/active window query). Without
 * this, every cold render re-runs the full `ledger_transactions` +
 * `card_withdrawal_requests` window scan, which on a 30d window on
 * prod-sized data can exceed the per-leg `safeQuery` timeout and degrade
 * the whole window to $0 — and because the un-cached read ran cold on every
 * reload, the degrade NEVER healed. Caching it means the first cold load
 * fills the cache and every reload inside the TTL is instant.
 *
 * CACHE-KEY CORRECTNESS: all inputs that vary the result are arguments and
 * therefore part of the key — the period, the cutoff ISO, the previous
 * window bounds (ISO or null), AND the scope inputs (`blacklistIdNotIn`,
 * `sessionWindowsCte`). So a changed blacklist or a changed creator
 * session-window set can never serve a stale cached value (the
 * `insights-analytics` / `dashboard-lifetime` tags ALSO bust it on a wipe /
 * restore, matching `cachedDailyOverview`). The ISO strings are parsed back
 * to Dates inside, so the query shape and binds are byte-identical to the
 * un-cached call — pure performance, no truth change.
 */
const cachedWindowQuery = unstable_cache(
  async (
    period: InsightsPeriod,
    currentCutoffIso: string,
    previousStartIso: string | null,
    previousEndIso: string | null,
    blacklistIdNotIn: string,
    sessionWindowsCte: string,
  ): Promise<{ current: RawWindowRow; previous: RawWindowRow }> => {
    return runWindowQuery({
      currentCutoff: new Date(currentCutoffIso),
      previousStart: previousStartIso ? new Date(previousStartIso) : null,
      previousEnd: previousEndIso ? new Date(previousEndIso) : null,
      blacklistIdNotIn,
      sessionWindowsCte,
    });
  },
  ["insights-analytics-overview-window-v1"],
  // Per-render TTL can't be passed to `unstable_cache` (the options object
  // is static), so the longer 300s revalidate is used and the 60s windows
  // simply re-warm more often via the page's own auto-refresh; the result
  // is correct either way (a slightly staler windowed figure is acceptable
  // and matches the existing `cachedDailyOverview` 300s TTL). Tagged so a
  // wipe/restore and exclusion change invalidate it (canonical tags).
  { revalidate: 300, tags: ["insights-analytics", "dashboard-lifetime"] },
);

/**
 * Period-keyed `unstable_cache` wrapper around the CANONICAL
 * `getWindowMetrics` (headline GGR/NGR/RTP/edge/bets) — THIS page's call of
 * it, NOT a cache on the shared function itself, so `/ggr` and the
 * dashboard (which call `getWindowMetrics` directly) are completely
 * unaffected. On a 30d window the canonical read is a full
 * `ledger_transactions` + `user_inventory` scan with correlated
 * borrow/reward-pack sub-selects; un-cached it re-ran cold on every reload
 * and degraded to all-zero GGR/NGR past the timeout. Caching heals that.
 *
 * CACHE-KEY CORRECTNESS: the cached value is byte-identical to
 * `getWindowMetrics({ window: { since } })`. Everything that varies it is
 * in the key — the period, the window `since` ISO (Lifetime already bounded
 * to 365d by the caller), AND the scope inputs (`blacklistIdNotIn`,
 * `sessionWindowsCte`). `getWindowMetrics` resolves the SAME scope
 * internally from `getMetricsScope()` (whose inputs are exactly the
 * blacklist + session windows passed here), so threading those two strings
 * through the key guarantees a changed scope busts the entry — it can never
 * serve a value computed under a different population. The canonical tags
 * bust it on a wipe/restore too.
 *
 * The `since` is reconstructed into the `MetricWindow` inside; no formula,
 * type set, or scope predicate is altered — `getWindowMetrics` is called
 * exactly as before, only memoised.
 */
const cachedWindowMetrics = unstable_cache(
  async (
    period: InsightsPeriod,
    sinceIso: string,
    blacklistIdNotIn: string,
    sessionWindowsCte: string,
  ): Promise<WindowMetrics> => {
    // `period` / `blacklistIdNotIn` / `sessionWindowsCte` are CACHE-KEY-ONLY
    // discriminators: `getWindowMetrics` resolves the scope itself from
    // `getMetricsScope()` (the SAME blacklist + session windows), so they
    // don't appear in the body — but they MUST be in the key so a changed
    // population (or period) never serves a stale value. `void` marks them
    // intentionally-unused-in-body (they ARE used by `unstable_cache` to
    // build the key from the arg list).
    void period;
    void blacklistIdNotIn;
    void sessionWindowsCte;
    return getWindowMetrics({ window: { since: new Date(sinceIso) } });
  },
  ["insights-analytics-overview-window-metrics-v1"],
  { revalidate: 300, tags: ["insights-analytics", "dashboard-lifetime"] },
);

/**
 * Period-keyed `unstable_cache` wrapper around the CANONICAL
 * `getDailyGamingMetrics` (daily GGR/NGR series). Same contract,
 * key-correctness, and tags as `cachedWindowMetrics`: it caches THIS page's
 * call (the shared function is untouched, so `/ggr` + dashboard are
 * unaffected), the cached value is byte-identical to
 * `getDailyGamingMetrics({ since })`, and every input that varies it (the
 * period, the `since` ISO — already bounded by the 180d sparkline horizon —
 * and the scope inputs) is in the key.
 */
const cachedDailyMetrics = unstable_cache(
  async (
    period: InsightsPeriod,
    sinceIso: string,
    blacklistIdNotIn: string,
    sessionWindowsCte: string,
  ): Promise<DailyGamingMetricPoint[]> => {
    // Same cache-key-only discriminators as `cachedWindowMetrics` — see the
    // `void` note there.
    void period;
    void blacklistIdNotIn;
    void sessionWindowsCte;
    return getDailyGamingMetrics({ since: new Date(sinceIso) });
  },
  ["insights-analytics-overview-daily-metrics-v1"],
  { revalidate: 300, tags: ["insights-analytics", "dashboard-lifetime"] },
);

function parseWindow(
  r: RawWindowRow,
  ggr: number,
  ngr: number,
): OverviewWindow {
  return {
    deposits: toNumber(r.deposits),
    depositCount: Number(r.deposit_count),
    withdrawals: toNumber(r.withdrawals),
    wager: toNumber(r.wager),
    wagerOrganic: toNumber(r.wager_organic),
    wagerCreatorCoded: toNumber(r.wager_creator_coded),
    ggr,
    ngr,
    newSignups: Number(r.signups),
    uniqueActive: Number(r.active),
  };
}

/**
 * Daily series for the overview sparklines. 5-minute cross-request cache
 * because the chart anchor is whole days — moves on day boundaries, not
 * seconds. Cache key includes the `since` ISO so each period's sparkline
 * has its own slot. Tagged so admin-managed exclusions invalidate it.
 *
 * Produces the deposits / withdrawals / wager / organic-wager / signups /
 * active daily series. GGR/NGR are NOT computed here — they come from the
 * canonical `getDailyGamingMetrics` and are merged in by
 * `getInsightsOverview` so the daily GGR/NGR reconciles with the headline
 * by construction.
 */
const cachedDailyOverview = unstable_cache(
  async (sinceIso: string, blacklistIdNotIn: string, sessionWindowsCte: string) => {
    const db = await getDb();
    const since = new Date(sinceIso);
    const wagerIn = Prisma.raw(METRICS_WAGER_TYPES_SQL);
    return db.$queryRaw<
      {
        date: Date;
        deposits: string;
        withdrawals: string;
        wager: string;
        wager_organic: string;
        wager_creator_coded: string;
        signups: string;
        active: string;
      }[]
    >`
      WITH real_users AS (
        SELECT u.id, u.role, u.created_at AS signup_at,
               EXISTS (
                 SELECT 1 FROM "user" ref
                 WHERE ref.id = u.referred_by AND ref.role = 'creator'
               ) AS under_creator
        FROM "user" u
        WHERE u.role NOT IN ('admin', 'support') ${Prisma.raw(blacklistIdNotIn)}
      ),
      ${Prisma.raw(sessionWindowsCte)},
      base AS (
        SELECT lt.user_id, lt.type, lt.amount::numeric AS amount, DATE(lt.created_at) AS d,
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
        WHERE lt.status = 'completed' AND lt.created_at >= ${since}
      ),
      daily_signups AS (
        SELECT DATE(signup_at) AS d, COUNT(*)::text AS signups
        FROM real_users
        WHERE signup_at >= ${since}
        GROUP BY DATE(signup_at)
      ),
      daily_withdrawals AS (
        SELECT DATE(COALESCE(cwr.completed_at, cwr.shipped_at)) AS d,
               COALESCE(SUM(cwr.total_value_usd::numeric), 0)::text AS amount
        FROM card_withdrawal_requests cwr
        JOIN real_users ru ON ru.id = cwr.user_id
        WHERE cwr.status IN ('completed', 'shipped')
          AND COALESCE(cwr.completed_at, cwr.shipped_at) >= ${since}
        GROUP BY DATE(COALESCE(cwr.completed_at, cwr.shipped_at))
      ),
      daily_base AS (
        SELECT
          d,
          COALESCE(SUM(CASE WHEN type::text = 'deposit' THEN amount ELSE 0 END), 0)::text AS deposits,
          COALESCE(SUM(CASE WHEN type::text IN ${wagerIn} AND NOT in_session THEN ABS(amount) ELSE 0 END), 0)::text AS wager,
          COALESCE(SUM(CASE WHEN type::text IN ${wagerIn} AND NOT in_session AND NOT under_creator THEN ABS(amount) ELSE 0 END), 0)::text AS wager_organic,
          COALESCE(SUM(CASE WHEN type::text IN ${wagerIn} AND NOT in_session AND under_creator THEN ABS(amount) ELSE 0 END), 0)::text AS wager_creator_coded,
          COUNT(DISTINCT user_id)::text AS active
        FROM base
        GROUP BY d
      )
      SELECT
        db.d AS date,
        db.deposits,
        COALESCE(dw.amount, '0') AS withdrawals,
        db.wager,
        db.wager_organic,
        db.wager_creator_coded,
        COALESCE(ds.signups, '0') AS signups,
        db.active
      FROM daily_base db
      LEFT JOIN daily_signups ds ON ds.d = db.d
      LEFT JOIN daily_withdrawals dw ON dw.d = db.d
      ORDER BY db.d
    `;
  },
  ["insights-analytics-overview-daily-v2"],
  { revalidate: 300, tags: ["insights-analytics", "dashboard-lifetime"] },
);
