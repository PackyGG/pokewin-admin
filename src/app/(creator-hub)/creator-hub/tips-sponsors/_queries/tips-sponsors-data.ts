import "server-only";

import { unstable_cache } from "next/cache";

import { queryMainRows } from "@/lib/drizzle-query";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import {
  type DashboardPeriod,
  periodToCutoff,
} from "@/lib/queries/dashboard-period";
import {
  type CreatorListItem,
  type CreatorSessionResponse,
} from "@/lib/backend-api";
import { BackendApiError, BackendNetworkError } from "@/lib/backend-api";
import {
  getCachedCreatorRoster,
  getCachedCreatorSessions,
} from "@/lib/cache/creator-backend-cache";
import { getTipsSponsorSpend } from "../../../../(admin)/creators/_queries/tips-sponsor-spend";
import { mapPool } from "../../_lib/backend-walk";

/** One creator's tips + sponsor spend (session-derived — authoritative totals). */
export type CreatorTipsSponsorRow = {
  id: string;
  username: string | null;
  image: string | null;
  isLive: boolean;
  tipsUsd: number;
  sponsorUsd: number;
  totalUsd: number;
  sessionsWithSpend: number;
};

export type TipsSponsorWindowStats = {
  tipsUsd: number;
  sponsorUsd: number;
  totalUsd: number;
  tipTxnCount: number;
  sponsorTxnCount: number;
};

export type TipsSponsorSessionStats = {
  tipsUsd: number;
  sponsorUsd: number;
  totalUsd: number;
  sessionsWithSpend: number;
  activeSessionsWithSpend: number;
  creatorsWithSpend: number;
};

export type TipsSponsorChartRow = {
  date: string;
  tips: number;
  sponsors: number;
};

/**
 * Fast leg — pure SQL against MAIN (ledger window Σ, lifetime Σ, fixed
 * 30-day daily trend). Streams in its own Suspense boundary ahead of the
 * per-creator backend fan-out.
 */
export type TipsSponsorsLedgerOverview = {
  period: DashboardPeriod;
  /** Ledger Σ in the selected window (`type::text` enum-safe). */
  ledgerWindow: TipsSponsorWindowStats;
  /** Lifetime ledger Σ (same legs as /creators KPI tile). */
  lifetime: TipsSponsorWindowStats;
  /** Fixed 30-day daily trend (ledger). */
  chart30d: TipsSponsorChartRow[];
};

/**
 * Slow leg — backend session fan-out (roster walk + per-creator session
 * sums). Streams behind its own Suspense boundary so the SQL KPIs above
 * never wait on it.
 */
export type TipsSponsorsSessionsOverview = {
  period: DashboardPeriod;
  /** Session-derived Σ in the selected window (authoritative when ledger is sparse). */
  sessionsWindow: TipsSponsorSessionStats;
  /** Per-creator breakdown in the selected window, ranked by total spend. */
  byCreator: CreatorTipsSponsorRow[];
  backendUnavailable: boolean;
};

const CREATOR_CONCURRENCY = 6;

export const TIP_TYPE = "creator_fill_spend_tip";
export const SPONSOR_TYPE = "creator_fill_spend_battle";

/**
 * ONE window source for both legs (task: reconcile the cutoffs). The
 * ledger SQL used to filter with `NOW() - INTERVAL '…'` (DB clock) while
 * the session fan-out compared against `periodToCutoff` (app clock) — two
 * clocks evaluated at different instants. Both legs now derive their
 * cutoff from this single `periodToCutoff` value; the ledger query binds
 * it as a `$1::timestamptz` parameter instead of computing its own.
 * "all" stays unbounded on both legs (unchanged behavior).
 */
function windowCutoff(period: DashboardPeriod): Date | null {
  return period === "all" ? null : periodToCutoff(period, new Date());
}

function emptyWindowStats(): TipsSponsorWindowStats {
  return {
    tipsUsd: 0,
    sponsorUsd: 0,
    totalUsd: 0,
    tipTxnCount: 0,
    sponsorTxnCount: 0,
  };
}

function sessionSpend(session: CreatorSessionResponse): {
  tips: number;
  sponsor: number;
} {
  const tips = Number(session.tips_spent_this_session_usd);
  const sponsor = Number(session.sponsorship_spent_this_session_usd);
  return {
    tips: Number.isFinite(tips) ? tips : 0,
    sponsor: Number.isFinite(sponsor) ? sponsor : 0,
  };
}

async function queryLedgerWindow(
  since: Date | null,
): Promise<TipsSponsorWindowStats> {
  const sinceClause = since ? `AND lt.created_at >= $1::timestamptz` : "";
  const values = since ? [since.toISOString()] : [];

  const rows = await queryMainRows<
    { type: string; total: string | null; count: string }[]
  >(
    `SELECT lt.type::text AS type,
            COALESCE(SUM(ABS(lt.amount::numeric)), 0)::text AS total,
            COUNT(*)::text AS count
       FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type::text IN ('${TIP_TYPE}', '${SPONSOR_TYPE}')
        ${sinceClause}
      GROUP BY lt.type::text`,
    ...values,
  );

  const stats = emptyWindowStats();
  for (const r of rows) {
    const amt = toNumber(r.total);
    const count = toNumber(r.count);
    if (r.type === TIP_TYPE) {
      stats.tipsUsd = amt;
      stats.tipTxnCount = count;
    } else if (r.type === SPONSOR_TYPE) {
      stats.sponsorUsd = amt;
      stats.sponsorTxnCount = count;
    }
  }
  stats.totalUsd = stats.tipsUsd + stats.sponsorUsd;
  return stats;
}

async function queryChart30d(): Promise<TipsSponsorChartRow[]> {
  const rows = await queryMainRows<
    { bucket: Date | string; type: string; total: string | null }[]
  >(
    `SELECT date_trunc('day', lt.created_at AT TIME ZONE 'UTC') AS bucket,
            lt.type::text AS type,
            COALESCE(SUM(ABS(lt.amount::numeric)), 0)::text AS total
       FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type::text IN ('${TIP_TYPE}', '${SPONSOR_TYPE}')
        AND lt.created_at >= NOW() - INTERVAL '30 days'
      GROUP BY 1, 2
      ORDER BY 1`,
  );

  const byDay = new Map<string, TipsSponsorChartRow>();
  for (const r of rows) {
    const date = new Date(r.bucket).toISOString().slice(0, 10);
    const prev = byDay.get(date) ?? { date, tips: 0, sponsors: 0 };
    const amt = toNumber(r.total);
    if (r.type === TIP_TYPE) prev.tips = amt;
    else if (r.type === SPONSOR_TYPE) prev.sponsors = amt;
    byDay.set(date, prev);
  }

  const out: TipsSponsorChartRow[] = [];
  const now = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - i);
    const date = d.toISOString().slice(0, 10);
    out.push(byDay.get(date) ?? { date, tips: 0, sponsors: 0 });
  }
  return out;
}

/**
 * Page the creator roster — delegates to the shared cached roster
 * (`getCachedCreatorRoster`), which runs the identical paged `creatorsApi.list`
 * walk (same cap/limit) and is Upstash-cached across fan-outs when configured,
 * or a pure pass-through to the live walk when dormant. The returned roster is
 * unchanged either way.
 */
async function listAllCreators(): Promise<CreatorListItem[]> {
  return getCachedCreatorRoster();
}

async function sumCreatorSessionSpend(
  userId: string,
  since: Date | null,
): Promise<{
  tipsUsd: number;
  sponsorUsd: number;
  sessionsWithSpend: number;
  activeSessionsWithSpend: number;
}> {
  let tipsUsd = 0;
  let sponsorUsd = 0;
  let sessionsWithSpend = 0;
  let activeSessionsWithSpend = 0;
  const sinceMs = since?.getTime() ?? 0;

  // Iterate the shared cached session list instead of paging the backend
  // directly. `getCachedCreatorSessions` runs the identical paged
  // `creatorsApi.listSessions` walk (same limit/page cap) and is Upstash-cached
  // when configured, or a pure pass-through to the live walk when dormant — so
  // the set of sessions is identical to the old in-loop paging. The since-date
  // filter + tip/sponsor summing below is unchanged.
  const sessions = await getCachedCreatorSessions(userId);
  for (const session of sessions) {
    if (since && new Date(session.activated_at).getTime() < sinceMs) continue;
    const { tips, sponsor } = sessionSpend(session);
    if (tips + sponsor <= 0) continue;
    tipsUsd += tips;
    sponsorUsd += sponsor;
    sessionsWithSpend += 1;
    if (session.status === "active") activeSessionsWithSpend += 1;
  }

  return { tipsUsd, sponsorUsd, sessionsWithSpend, activeSessionsWithSpend };
}

async function computeTipsSponsorsLedger(
  period: DashboardPeriod,
): Promise<TipsSponsorsLedgerOverview> {
  return withTiming("creator-hub.tipsSponsors.ledger", async () => {
    const since = windowCutoff(period);

    const [ledgerWindow, lifetimeRaw, chart30d] = await Promise.all([
      queryLedgerWindow(since),
      getTipsSponsorSpend(),
      queryChart30d(),
    ]);

    const lifetime: TipsSponsorWindowStats = {
      tipsUsd: lifetimeRaw.tipSpendUsd,
      sponsorUsd: lifetimeRaw.sponsorSpendUsd,
      totalUsd: lifetimeRaw.totalUsd,
      tipTxnCount: 0,
      sponsorTxnCount: 0,
    };

    return { period, ledgerWindow, lifetime, chart30d };
  });
}

async function computeTipsSponsorsSessions(
  period: DashboardPeriod,
): Promise<TipsSponsorsSessionsOverview> {
  return withTiming("creator-hub.tipsSponsors.sessions", async () => {
    const sinceDate = windowCutoff(period);

    let backendUnavailable = false;
    let byCreator: CreatorTipsSponsorRow[] = [];
    const sessionsWindow: TipsSponsorSessionStats = {
      tipsUsd: 0,
      sponsorUsd: 0,
      totalUsd: 0,
      sessionsWithSpend: 0,
      activeSessionsWithSpend: 0,
      creatorsWithSpend: 0,
    };

    try {
      const creators = await listAllCreators();
      const rows = await mapPool(creators, CREATOR_CONCURRENCY, async (c) => {
        const spend = await sumCreatorSessionSpend(c.id, sinceDate);
        return {
          id: c.id,
          username: c.username,
          image: c.image,
          isLive: c.active_session_id != null,
          tipsUsd: spend.tipsUsd,
          sponsorUsd: spend.sponsorUsd,
          totalUsd: spend.tipsUsd + spend.sponsorUsd,
          sessionsWithSpend: spend.sessionsWithSpend,
          activeSessionsWithSpend: spend.activeSessionsWithSpend,
        };
      });

      for (const r of rows) {
        sessionsWindow.tipsUsd += r.tipsUsd;
        sessionsWindow.sponsorUsd += r.sponsorUsd;
        sessionsWindow.sessionsWithSpend += r.sessionsWithSpend;
        sessionsWindow.activeSessionsWithSpend += r.activeSessionsWithSpend;
        if (r.totalUsd > 0) sessionsWindow.creatorsWithSpend += 1;
      }
      sessionsWindow.totalUsd =
        sessionsWindow.tipsUsd + sessionsWindow.sponsorUsd;

      byCreator = rows
        .filter((r) => r.totalUsd > 0)
        .sort((a, b) => b.totalUsd - a.totalUsd);
    } catch (err) {
      if (
        err instanceof BackendApiError ||
        err instanceof BackendNetworkError
      ) {
        backendUnavailable = true;
      } else {
        throw err;
      }
    }

    return { period, sessionsWindow, byCreator, backendUnavailable };
  });
}

// Same revalidate/tag semantics the combined "creator-hub-tips-sponsors-v1"
// cache carried, split per leg so the fast SQL stream never waits on (or
// shares an entry with) the backend fan-out.
const cachedTipsSponsorsLedger = unstable_cache(
  computeTipsSponsorsLedger,
  ["creator-hub-tips-sponsors-ledger-v1"],
  { revalidate: 120, tags: ["creator-hub"] },
);

const cachedTipsSponsorsSessions = unstable_cache(
  computeTipsSponsorsSessions,
  ["creator-hub-tips-sponsors-sessions-v1"],
  { revalidate: 120, tags: ["creator-hub"] },
);

export async function getTipsSponsorsLedgerOverview(
  period: DashboardPeriod,
): Promise<TipsSponsorsLedgerOverview> {
  return cachedTipsSponsorsLedger(period);
}

export async function getTipsSponsorsSessionsOverview(
  period: DashboardPeriod,
): Promise<TipsSponsorsSessionsOverview> {
  return cachedTipsSponsorsSessions(period);
}
