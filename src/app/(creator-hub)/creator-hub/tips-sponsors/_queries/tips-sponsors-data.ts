import "server-only";

import { unstable_cache } from "next/cache";

import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import {
  type DashboardPeriod,
  periodToCutoff,
} from "@/lib/queries/dashboard-period";
import {
  creatorsApi,
  type CreatorListItem,
  type CreatorSessionResponse,
} from "@/lib/backend-api";
import { BackendApiError, BackendNetworkError } from "@/lib/backend-api";
import { hubPeriodToInterval } from "../../_queries/hub-period-sql";
import { getTipsSponsorSpend } from "../../../../(admin)/creators/_queries/tips-sponsor-spend";

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

export type TipsSponsorsOverview = {
  period: DashboardPeriod;
  /** Ledger Σ in the selected window (`type::text` enum-safe). */
  ledgerWindow: TipsSponsorWindowStats;
  /** Lifetime ledger Σ (same legs as /creators KPI tile). */
  lifetime: TipsSponsorWindowStats;
  /** Session-derived Σ in the selected window (authoritative when ledger is sparse). */
  sessionsWindow: TipsSponsorSessionStats;
  /** Per-creator breakdown in the selected window, ranked by total spend. */
  byCreator: CreatorTipsSponsorRow[];
  /** Fixed 30-day daily trend (ledger). */
  chart30d: TipsSponsorChartRow[];
  backendUnavailable: boolean;
};

const SESSIONS_PAGE_LIMIT = 100;
const MAX_SESSION_PAGES = 100;
const CREATOR_LIST_CAP = 500;
const CREATOR_CONCURRENCY = 6;

const TIP_TYPE = "creator_fill_spend_tip";
const SPONSOR_TYPE = "creator_fill_spend_battle";

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
  sinceSql: string | null,
): Promise<TipsSponsorWindowStats> {
  const db = await getDb();
  const sinceClause = sinceSql ? `AND lt.created_at >= ${sinceSql}` : "";

  const rows = await db.$queryRawUnsafe<
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
  const db = await getDb();
  const rows = await db.$queryRawUnsafe<
    { bucket: Date; type: string; total: string | null }[]
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

async function listAllCreators(): Promise<CreatorListItem[]> {
  const out: CreatorListItem[] = [];
  let offset = 0;
  while (out.length < CREATOR_LIST_CAP) {
    const slice = await creatorsApi.list({ limit: 100, offset });
    out.push(...slice.data);
    offset += slice.data.length;
    if (slice.data.length === 0 || offset >= slice.total) break;
  }
  return out;
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
  let offset = 0;
  const sinceMs = since?.getTime() ?? 0;

  for (let page = 0; page < MAX_SESSION_PAGES; page++) {
    const slice = await creatorsApi.listSessions(userId, {
      limit: SESSIONS_PAGE_LIMIT,
      offset,
    });

    for (const session of slice.data) {
      if (since && new Date(session.activated_at).getTime() < sinceMs) continue;
      const { tips, sponsor } = sessionSpend(session);
      if (tips + sponsor <= 0) continue;
      tipsUsd += tips;
      sponsorUsd += sponsor;
      sessionsWithSpend += 1;
      if (session.status === "active") activeSessionsWithSpend += 1;
    }

    offset += slice.data.length;
    if (slice.data.length === 0 || offset >= slice.total) break;
  }

  return { tipsUsd, sponsorUsd, sessionsWithSpend, activeSessionsWithSpend };
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await fn(items[i]!);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );
  return out;
}

async function computeTipsSponsorsOverview(
  period: DashboardPeriod,
): Promise<TipsSponsorsOverview> {
  return withTiming("creator-hub.tipsSponsors", async () => {
    const interval = hubPeriodToInterval(period);
    const sinceSql =
      period === "all" ? null : `NOW() - INTERVAL '${interval}'`;
    const sinceDate = period === "all" ? null : periodToCutoff(period, new Date());

    const [ledgerWindow, lifetimeRaw, chart30d] = await Promise.all([
      queryLedgerWindow(sinceSql),
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

    return {
      period,
      ledgerWindow,
      lifetime,
      sessionsWindow,
      byCreator,
      chart30d,
      backendUnavailable,
    };
  });
}

const cachedTipsSponsorsOverview = unstable_cache(
  computeTipsSponsorsOverview,
  ["creator-hub-tips-sponsors-v1"],
  { revalidate: 120, tags: ["creator-hub"] },
);

export async function getTipsSponsorsOverview(
  period: DashboardPeriod,
): Promise<TipsSponsorsOverview> {
  return cachedTipsSponsorsOverview(period);
}
