import "server-only";

import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { toNumber } from "@/lib/utils/decimal";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";
import { getCreatorSessionWindowsCte } from "@/lib/queries/creator-session-windows";
import {
  WAGER_TYPES_SQL,
  PAYOUT_TYPES_SQL,
} from "@/lib/queries/_wager-payout-types";
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
 * Mirrors the GGR fix landed in 7390363: creator on-stream sessions are
 * dropped from BOTH the wager AND payout side of GGR via the same
 * session_windows CTE pnl.ts / dashboard.ts use, so the headline figures
 * match those pages by construction.
 *
 * Staff (admin / support) and the manual blacklist are excluded
 * everywhere, including the sparkline series.
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
  ggr: number;
  ngr: number;
  signups: number;
  active: number;
};

/**
 * Period scopes the cutoff for the current window (and an identical-width
 * prior window for comparisons). Lifetime skips the prior-window
 * comparison and the sparkline horizon is capped at 180d so the query
 * stays bounded.
 */
export async function getInsightsOverview(
  period: InsightsPeriod,
): Promise<OverviewKpis> {
  const now = new Date();
  const cutoff = periodToCutoff(period, now);
  const previous = previousPeriodCutoff(period, now);
  const excluded = await getExcludedUserIds();
  const blacklistIdNotIn = blacklistNotInClause("id", excluded);
  const sessionWindowsCte = await getCreatorSessionWindowsCte();

  const [windows, daily] = await Promise.all([
    runWindowQuery({
      currentCutoff: cutoff,
      previousStart: previous?.start ?? null,
      previousEnd: previous?.end ?? null,
      blacklistIdNotIn,
      sessionWindowsCte,
    }),
    cachedDailyOverview(
      // sparkline horizon = lifetime caps at 180d, otherwise we want the
      // full period plus one mirror window so the chart can visually
      // separate "this period" from "last period" later if needed.
      sparkSinceForPeriod(period, now).toISOString(),
      blacklistIdNotIn,
      sessionWindowsCte,
    ),
  ]);

  return {
    current: parseWindow(windows.current),
    previous: previous ? parseWindow(windows.previous) : null,
    daily: daily.map((d) => ({
      date: new Date(d.date).toISOString().slice(0, 10),
      deposits: toNumber(d.deposits),
      withdrawals: toNumber(d.withdrawals),
      wager: toNumber(d.wager),
      ggr: toNumber(d.ggr),
      ngr: toNumber(d.ngr),
      signups: Number(d.signups),
      active: Number(d.active),
    })),
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
  // Current window aggregates
  deposits: string;
  deposit_count: string;
  withdrawals: string;
  wager: string;
  ggr: string;
  ngr: string;
  signups: string;
  active: string;
  // Previous window aggregates (null when no previous window)
  prev_deposits: string;
  prev_deposit_count: string;
  prev_withdrawals: string;
  prev_wager: string;
  prev_ggr: string;
  prev_ngr: string;
  prev_signups: string;
  prev_active: string;
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

  const ggrWagerIn = Prisma.raw(WAGER_TYPES_SQL);
  const ggrPayoutIn = Prisma.raw(PAYOUT_TYPES_SQL);
  // NGR = GGR − bonus payouts. Use the canonical bonus type list — same
  // bucket the legacy analytics.ts pulls for `reward_*` series. Distinct
  // from the GGR payout list so the columns stay independent.
  const bonusTypesSql = Prisma.raw(
    `('deposit_bonus','promo_code_redeemed','gift_card_redeemed','rakeback_claim','affiliate_claim','rain_win','race_prize','creator_tip','waitlist_prize','voucher_redeemed','voucher_exchange','exchange_excess_credit','exchange_excess_to_voucher','battle_excess_to_voucher')`,
  );

  const rows = await db.$queryRaw<
    {
      window: "current" | "previous";
      deposits: string;
      deposit_count: string;
      withdrawals: string;
      wager: string;
      ggr: string;
      ngr: string;
      signups: string;
      active: string;
    }[]
  >`
    WITH real_users AS (
      SELECT u.id, u.role, u.created_at AS signup_at
      FROM "user" u
      WHERE u.role NOT IN ('admin', 'support') ${Prisma.raw(blacklistIdNotIn)}
    ),
    ${Prisma.raw(sessionWindowsCte)},
    base AS (
      -- Same in_session pattern dashboard.ts uses: a creator wager
      -- placed while live on a deal/stream is house-funded sponsored
      -- play, not a real customer bet — dropped from BOTH the wager
      -- and payout side of GGR/NGR so the figures match the GGR card
      -- on the dashboard by construction.
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
        cwr.total_value_usd::numeric AS amount,
        COALESCE(cwr.completed_at, cwr.shipped_at) AS effective_at
      FROM card_withdrawal_requests cwr
      JOIN real_users ru ON ru.id = cwr.user_id
      WHERE cwr.status IN ('completed', 'shipped')
    )
    SELECT
      'current'::text AS window,
      COALESCE(SUM(CASE WHEN type = 'deposit' AND created_at >= ${currentCutoff} THEN amount ELSE 0 END), 0)::text AS deposits,
      COUNT(CASE WHEN type = 'deposit' AND created_at >= ${currentCutoff} THEN 1 END)::text AS deposit_count,
      COALESCE((SELECT SUM(CASE WHEN effective_at >= ${currentCutoff} THEN amount ELSE 0 END) FROM withdrawals), 0)::text AS withdrawals,
      COALESCE(SUM(CASE WHEN type IN ${ggrWagerIn} AND NOT in_session AND created_at >= ${currentCutoff} THEN ABS(amount) ELSE 0 END), 0)::text AS wager,
      (
        COALESCE(SUM(CASE WHEN type IN ${ggrWagerIn} AND NOT in_session AND created_at >= ${currentCutoff} THEN ABS(amount) ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN type IN ${ggrPayoutIn} AND NOT in_session AND created_at >= ${currentCutoff} THEN ABS(amount) ELSE 0 END), 0)
      )::text AS ggr,
      (
        COALESCE(SUM(CASE WHEN type IN ${ggrWagerIn} AND NOT in_session AND created_at >= ${currentCutoff} THEN ABS(amount) ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN type IN ${ggrPayoutIn} AND NOT in_session AND created_at >= ${currentCutoff} THEN ABS(amount) ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN type IN ${bonusTypesSql} AND created_at >= ${currentCutoff} THEN ABS(amount) ELSE 0 END), 0)
      )::text AS ngr,
      (SELECT COUNT(*)::text FROM real_users WHERE signup_at >= ${currentCutoff}) AS signups,
      COUNT(DISTINCT CASE WHEN created_at >= ${currentCutoff} THEN user_id END)::text AS active
    FROM base
    UNION ALL
    SELECT
      'previous'::text AS window,
      COALESCE(SUM(CASE WHEN type = 'deposit' AND created_at >= ${prevStart} AND created_at < ${prevEnd} THEN amount ELSE 0 END), 0)::text AS deposits,
      COUNT(CASE WHEN type = 'deposit' AND created_at >= ${prevStart} AND created_at < ${prevEnd} THEN 1 END)::text AS deposit_count,
      COALESCE((SELECT SUM(CASE WHEN effective_at >= ${prevStart} AND effective_at < ${prevEnd} THEN amount ELSE 0 END) FROM withdrawals), 0)::text AS withdrawals,
      COALESCE(SUM(CASE WHEN type IN ${ggrWagerIn} AND NOT in_session AND created_at >= ${prevStart} AND created_at < ${prevEnd} THEN ABS(amount) ELSE 0 END), 0)::text AS wager,
      (
        COALESCE(SUM(CASE WHEN type IN ${ggrWagerIn} AND NOT in_session AND created_at >= ${prevStart} AND created_at < ${prevEnd} THEN ABS(amount) ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN type IN ${ggrPayoutIn} AND NOT in_session AND created_at >= ${prevStart} AND created_at < ${prevEnd} THEN ABS(amount) ELSE 0 END), 0)
      )::text AS ggr,
      (
        COALESCE(SUM(CASE WHEN type IN ${ggrWagerIn} AND NOT in_session AND created_at >= ${prevStart} AND created_at < ${prevEnd} THEN ABS(amount) ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN type IN ${ggrPayoutIn} AND NOT in_session AND created_at >= ${prevStart} AND created_at < ${prevEnd} THEN ABS(amount) ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN type IN ${bonusTypesSql} AND created_at >= ${prevStart} AND created_at < ${prevEnd} THEN ABS(amount) ELSE 0 END), 0)
      )::text AS ngr,
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
      ggr: current.ggr,
      ngr: current.ngr,
      signups: current.signups,
      active: current.active,
      // Previous values placeholder — not consumed in this row.
      prev_deposits: "0",
      prev_deposit_count: "0",
      prev_withdrawals: "0",
      prev_wager: "0",
      prev_ggr: "0",
      prev_ngr: "0",
      prev_signups: "0",
      prev_active: "0",
    },
    previous: {
      deposits: prev.deposits,
      deposit_count: prev.deposit_count,
      withdrawals: prev.withdrawals,
      wager: prev.wager,
      ggr: prev.ggr,
      ngr: prev.ngr,
      signups: prev.signups,
      active: prev.active,
      prev_deposits: "0",
      prev_deposit_count: "0",
      prev_withdrawals: "0",
      prev_wager: "0",
      prev_ggr: "0",
      prev_ngr: "0",
      prev_signups: "0",
      prev_active: "0",
    },
  };
}

function parseWindow(r: RawWindowRow): OverviewWindow {
  return {
    deposits: toNumber(r.deposits),
    depositCount: Number(r.deposit_count),
    withdrawals: toNumber(r.withdrawals),
    wager: toNumber(r.wager),
    ggr: toNumber(r.ggr),
    ngr: toNumber(r.ngr),
    newSignups: Number(r.signups),
    uniqueActive: Number(r.active),
  };
}

/**
 * Daily series for the overview sparklines. 5-minute cross-request cache
 * because the chart anchor is whole days — moves on day boundaries, not
 * seconds. Cache key includes the `since` ISO so each period's sparkline
 * has its own slot. Tagged so admin-managed exclusions invalidate it.
 */
const cachedDailyOverview = unstable_cache(
  async (sinceIso: string, blacklistIdNotIn: string, sessionWindowsCte: string) => {
    const db = await getDb();
    const since = new Date(sinceIso);
    const ggrWagerIn = Prisma.raw(WAGER_TYPES_SQL);
    const ggrPayoutIn = Prisma.raw(PAYOUT_TYPES_SQL);
    const bonusTypesSql = Prisma.raw(
      `('deposit_bonus','promo_code_redeemed','gift_card_redeemed','rakeback_claim','affiliate_claim','rain_win','race_prize','creator_tip','waitlist_prize','voucher_redeemed','voucher_exchange','exchange_excess_credit','exchange_excess_to_voucher','battle_excess_to_voucher')`,
    );
    return db.$queryRaw<
      {
        date: Date;
        deposits: string;
        withdrawals: string;
        wager: string;
        ggr: string;
        ngr: string;
        signups: string;
        active: string;
      }[]
    >`
      WITH real_users AS (
        SELECT u.id, u.role, u.created_at AS signup_at FROM "user" u
        WHERE u.role NOT IN ('admin', 'support') ${Prisma.raw(blacklistIdNotIn)}
      ),
      ${Prisma.raw(sessionWindowsCte)},
      base AS (
        SELECT lt.user_id, lt.type, lt.amount::numeric AS amount, DATE(lt.created_at) AS d,
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
          COALESCE(SUM(CASE WHEN type = 'deposit' THEN amount ELSE 0 END), 0)::text AS deposits,
          COALESCE(SUM(CASE WHEN type IN ${ggrWagerIn} AND NOT in_session THEN ABS(amount) ELSE 0 END), 0)::text AS wager,
          (
            COALESCE(SUM(CASE WHEN type IN ${ggrWagerIn} AND NOT in_session THEN ABS(amount) ELSE 0 END), 0)
            - COALESCE(SUM(CASE WHEN type IN ${ggrPayoutIn} AND NOT in_session THEN ABS(amount) ELSE 0 END), 0)
          )::text AS ggr,
          (
            COALESCE(SUM(CASE WHEN type IN ${ggrWagerIn} AND NOT in_session THEN ABS(amount) ELSE 0 END), 0)
            - COALESCE(SUM(CASE WHEN type IN ${ggrPayoutIn} AND NOT in_session THEN ABS(amount) ELSE 0 END), 0)
            - COALESCE(SUM(CASE WHEN type IN ${bonusTypesSql} THEN ABS(amount) ELSE 0 END), 0)
          )::text AS ngr,
          COUNT(DISTINCT user_id)::text AS active
        FROM base
        GROUP BY d
      )
      SELECT
        db.d AS date,
        db.deposits,
        COALESCE(dw.amount, '0') AS withdrawals,
        db.wager,
        db.ggr,
        db.ngr,
        COALESCE(ds.signups, '0') AS signups,
        db.active
      FROM daily_base db
      LEFT JOIN daily_signups ds ON ds.d = db.d
      LEFT JOIN daily_withdrawals dw ON dw.d = db.d
      ORDER BY db.d
    `;
  },
  ["insights-analytics-overview-daily-v1"],
  { revalidate: 300, tags: ["insights-analytics", "dashboard-lifetime"] },
);
