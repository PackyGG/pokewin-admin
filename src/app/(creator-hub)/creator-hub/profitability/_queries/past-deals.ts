import "server-only";

import { unstable_cache } from "next/cache";

import { getDb } from "@/lib/db";
import {
  affiliateLeaderboardsApi,
  type LeaderboardAdminRow,
} from "@/lib/backend-api/affiliate-leaderboards";
import { resolveAdminRead } from "@/lib/clickhouse/resolve-read";
import { safeQuery } from "@/lib/errors/safe-query";
import { getLeaderboardSponsorshipMap } from "../../../../(admin)/creators/_queries/leaderboard-sponsorship";
import {
  getCreatorLeaderboardWagerMap,
  type LeaderboardWagerInput,
} from "../../../../(admin)/creators/[userId]/_queries/leaderboard-wager-by-board";
import { getBoardAffiliatePnl } from "./frame-affiliate-pnl-by-board";

/**
 * Creator Hub — Past Deals data.
 *
 * Mirrors the Active view's "the leaderboard frame IS the deal" model: a
 * PAST deal is an APPROVED creator leaderboard whose run window has
 * ENDED (`end_date < now`). Each ended board → one row, costed and
 * conversion-checked over its OWN lifetime window `[start, end]`.
 *
 *   dealCost      = (total_prize_usd − refund) × sponsored% / 100 —
 *                   the same house-cost figure {@link getLiveLeaderboards}
 *                   surfaces for ended boards (rose).
 *   expectedWager = dealCost / house edge (7.5%).
 *   actualWager   = code-cohort wager inside [start, end] — same as
 *                   the per-board "Total Wager" `getCreatorLeaderboardWagerMap`
 *                   computes for the detail card (snapshot-aware: settled
 *                   boards use the weighted snapshot total, live/in-flight
 *                   fall through to the raw acu scan).
 *   conversion    = actualWager / expectedWager (≥ 1× = the board paid
 *                   for itself).
 *   affiliatesMadeUs = coverage-attributed deposits − card withdrawals
 *                   − the creator's own affiliate_claim earnings, over
 *                   the FULL board window [start, end], computed by
 *                   {@link getBoardAffiliatePnl}.
 *   actualPnl     = affiliatesMadeUs − dealCost (house-profit convention:
 *                   + = the cohort earned back more than the board cost).
 *
 * The dealCost here is the BOARD's house cost ONLY — the per-week withdraw
 * cap leg from the Active view doesn't apply per-board (caps are deal-level
 * and a creator's deal lasts across many boards). The expected-wager / PnL
 * checks remain meaningful (the board's prize is its own deliverable).
 *
 * Pagination is SERVER-SIDE via `?page=` (PAGE_SIZE = 25). Sorted by
 * end_date DESC (most-recently ended first). The backend already paginates
 * the leaderboards endpoint, so we only walk the pages we need.
 */

/** Past deals per page. URL-driven via `?page=N`. */
export const PAST_DEALS_PAGE_SIZE = 25;
const HOUSE_EDGE = 0.075;

/** Backend cap per request. */
const BACKEND_PAGE_SIZE = 100;
/** Cold-walk safety cap (creator leaderboards are a small bounded set). */
const FETCH_CAP = 2000;

/**
 * Per-leg timeout (ms) for the page-scoped heavy reads. Long enough that a
 * healthy cold scan on prod-sized data completes (the per-board PnL scan
 * uses a 55s `SET LOCAL statement_timeout` inside its own transaction); short
 * enough that a pathological hang degrades to the empty-state card instead
 * of running out the function budget on Vercel and surfacing as a 500.
 * Mirrors the budget shape used by other heavy admin reads (`REWARD_QUERY_TIMEOUT_MS`,
 * with extra headroom because the per-board PnL transaction is the heaviest
 * read in the Creator Hub).
 */
const PAST_DEALS_LEG_TIMEOUT_MS = 60_000;

/**
 * `resolveAdminRead` surface key for the past-deals page-scoped compute.
 *
 * Sits in the dormant state (NOT in `CUTOVER_DEFAULT_CLICKHOUSE`): with no
 * ClickHouse client provisioned the resolver returns `"off"` and the surface
 * serves Postgres unchanged. Wiring the call through `resolveAdminRead`
 * satisfies the Index-or-ClickHouse construct so a CH twin can later be
 * dropped in without re-plumbing the page, and Edge Config / env-var
 * overrides remain available for per-surface flips. The `ch` leg throws by
 * design — it is unreachable today, and on a future flip without a built
 * twin the resolver THROWS so the page's empty-state path is taken (the
 * resolver MUST NOT silently re-run the heavy Postgres aggregate).
 */
const PAST_DEALS_SURFACE_KEY = "creator_hub_profitability_past_deals";

export type PastDealRow = {
  /** Backend leaderboard id (= the past deal id, stable). */
  boardId: string;
  /** Board title (the deal's display name). */
  boardTitle: string;
  /** Primary owner's user id. */
  userId: string;
  /** Resolved owner username (MAIN read), or null when unresolved. */
  username: string | null;
  /** Owner's profile image (MAIN read), or null when unresolved. */
  image: string | null;
  /** Affiliate codes that fed the board. */
  affiliateCodes: string[];
  /** Frame start (epoch ms) — the board's `start_date`. */
  frameStartMs: number;
  /** Frame end (epoch ms) — the board's `end_date`. */
  frameEndMs: number;
  /** Full prize pool, net of refunds (100%, no sponsored-% weighting). */
  prizeUsd: number;
  /** Admin-set sponsored % (0–100); 100 when un-annotated. */
  sponsoredPct: number;
  /** House's share of the pool: prizeUsd × sponsoredPct / 100 (rose). */
  dealCost: number;
  expectedWager: number;
  actualWager: number;
  /** Coverage-attributed deposits − card withdrawals − affiliate claims, this window. */
  affiliatesMadeUs: number;
  /** `affiliatesMadeUs − dealCost` (house-profit convention). */
  actualPnl: number;
  /** `expectedWager > 0 ? actualWager / expectedWager : 0`. */
  conversionRate: number;
};

export type PastDealsTotals = {
  /** Total ended deals across the FULL set (drives pagination) — NOT page-scoped. */
  totalEndedDeals: number;
  /** Σ dealCost across the CURRENT PAGE (rose house cost). */
  totalCost: number;
  /** Σ affiliatesMadeUs across the CURRENT PAGE (house POV). */
  totalAffiliatesMadeUs: number;
  /** Σ actualPnl across the CURRENT PAGE. */
  totalActualPnl: number;
  /** Σ expectedWager across the CURRENT PAGE (= page totalCost / house edge). */
  totalExpectedWager: number;
  /** Σ actualWager across the CURRENT PAGE. */
  totalCreatorWager: number;
  /** Avg conversion across page boards with expectedWager > 0. */
  avgConversionRate: number;
};

export type PastDealsData = {
  /** Current-page rows (≤ PAST_DEALS_PAGE_SIZE). */
  rows: PastDealRow[];
  /**
   * KPI-strip aggregates. Every MONEY total (cost, expected wager, wager,
   * affiliates-made-us, PnL, conversion) is PAGE-SCOPED — it describes the
   * same 25 boards in `rows` so the strip is internally coherent. Only
   * `totalEndedDeals` (+ `totalCount`) is full-set.
   */
  totals: PastDealsTotals;
  /** Total ended boards (for pagination footer). */
  totalCount: number;
  /** 1-based current page (clamped to valid range). */
  page: number;
  /** Total page count (≥ 1). */
  totalPages: number;
  /** True when the backend leaderboard walk failed (UI shows empty). */
  backendUnavailable: boolean;
};

const EMPTY_TOTALS: PastDealsTotals = {
  totalEndedDeals: 0,
  totalCost: 0,
  totalAffiliatesMadeUs: 0,
  totalActualPnl: 0,
  totalExpectedWager: 0,
  totalCreatorWager: 0,
  avgConversionRate: 0,
};

/** Walk every APPROVED leaderboard, first-page-then-parallel, up to FETCH_CAP. */
async function walkAllApprovedLeaderboards(): Promise<LeaderboardAdminRow[]> {
  const firstPage = await affiliateLeaderboardsApi.list({
    status: "approved",
    offset: 0,
    limit: BACKEND_PAGE_SIZE,
  });
  const all: LeaderboardAdminRow[] = [...firstPage.leaderboards];

  const pagesNeeded = Math.min(
    Math.ceil(FETCH_CAP / BACKEND_PAGE_SIZE),
    Math.ceil(firstPage.total / BACKEND_PAGE_SIZE),
  );
  const rest: Promise<typeof firstPage>[] = [];
  for (let p = 1; p < pagesNeeded; p++) {
    rest.push(
      affiliateLeaderboardsApi.list({
        status: "approved",
        offset: p * BACKEND_PAGE_SIZE,
        limit: BACKEND_PAGE_SIZE,
      }),
    );
  }
  for (const page of await Promise.all(rest)) {
    all.push(...page.leaderboards);
  }
  return all;
}

/**
 * Cached approved-leaderboard walk + per-board cost (sponsored-weighted).
 * This is the LIGHT part: identity, dates, cost. Wager + PnL are computed
 * per-page (heavy MAIN reads) AFTER this returns so the cache stays small
 * and reusable across page flips.
 */
const getEndedDealsBase = unstable_cache(
  async (): Promise<{
    rows: PastDealBaseRow[];
    backendUnavailable: boolean;
  }> => {
    let all: LeaderboardAdminRow[];
    try {
      all = await walkAllApprovedLeaderboards();
    } catch (e) {
      console.error(
        "[past-deals] approved-board walk failed (page empty):",
        e,
      );
      return { rows: [], backendUnavailable: true };
    }

    let sponsorship: Map<string, number>;
    try {
      sponsorship = await getLeaderboardSponsorshipMap(all.map((lb) => lb.id));
    } catch (e) {
      console.error(
        "[past-deals] sponsorship lookup failed (treating all as 100%):",
        e,
      );
      sponsorship = new Map();
    }

    const now = Date.now();
    const ended: PastDealBaseRow[] = [];
    for (const lb of all) {
      const startMs = new Date(lb.start_date).getTime();
      const endMs = new Date(lb.end_date).getTime();
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
      // Past board = end strictly in the past. Same date math as the
      // leaderboard-cost tile's "pastHouseCostUsd" partition.
      if (endMs >= now) continue;

      const prize = Number(lb.total_prize_usd) || 0;
      const refund = Number(lb.refund_amount_usd) || 0;
      const net = prize - refund;
      const pct = Math.min(100, Math.max(0, sponsorship.get(lb.id) ?? 100));
      const houseCost = net * (pct / 100);

      ended.push({
        boardId: lb.id,
        boardTitle: lb.title,
        userId: lb.creator_user_id,
        coCreatorUserIds: lb.co_creator_user_ids ?? [],
        affiliateCodes: lb.affiliate_codes ?? [],
        frameStartMs: startMs,
        frameEndMs: endMs,
        prizeUsd: net,
        sponsoredPct: pct,
        dealCost: houseCost,
      });
    }

    // Most-recently ended first (the default sort).
    ended.sort((a, b) => b.frameEndMs - a.frameEndMs);
    return { rows: ended, backendUnavailable: false };
  },
  ["profitability-past-deals-base-v1"],
  { revalidate: 300, tags: ["profitability-past-deals"] },
);

type PastDealBaseRow = {
  boardId: string;
  boardTitle: string;
  userId: string;
  coCreatorUserIds: string[];
  affiliateCodes: string[];
  frameStartMs: number;
  frameEndMs: number;
  prizeUsd: number;
  sponsoredPct: number;
  dealCost: number;
};

function clampPage(requested: number, totalPages: number): number {
  if (!Number.isFinite(requested) || requested < 1) return 1;
  return Math.min(Math.floor(requested), Math.max(1, totalPages));
}

/**
 * Parse a `?page=` value into a 1-based int. Falls back to 1 on missing /
 * invalid input; the final clamp to the available range happens inside
 * {@link getPastDeals} once `totalPages` is known.
 */
export function parsePastDealsPage(raw: string | undefined): number {
  if (!raw) return 1;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/**
 * Past Deals data layer.
 *
 * Page-scoped: heavy MAIN reads (wager + PnL) only run for the 25 boards on
 * the active page, mirroring the active-timeframe-only rule (no eager scan
 * of every past board's wager/PnL on every request). The KPI-strip money
 * totals are therefore ALL page-scoped (cost + expected wager included) so
 * the strip stays internally coherent; only the ended-deal COUNT is full-set.
 *
 * Routed through `resolveAdminRead` (Index-or-ClickHouse construct). With no
 * ClickHouse twin built, the surface stays dormant; the resolver returns the
 * `pg()` value (`computePastDealsFromPostgres` below). The `pg` leg itself
 * uses `safeQuery` per heavy leg so a slow scan degrades the leg to its
 * fallback value instead of taking down the whole request — the PageHero +
 * tab strip always render via the page shell, the inner section degrades to
 * an empty-state card.
 */
export async function getPastDeals(page: number): Promise<PastDealsData> {
  // Final-mile safety: even though every internal leg is wrapped in
  // `safeQuery`, unexpected throws (Edge Config error on
  // `getAdminReadMode`, surprise import-time crash, etc.) must NOT blow up
  // the request — the PageHero + tab strip must always render and the
  // section must degrade to the "backendUnavailable" card.
  try {
    return await resolveAdminRead(PAST_DEALS_SURFACE_KEY, {
      pg: () => computePastDealsFromPostgres(page),
      ch: () => {
        // No CH twin yet. The surface is intentionally NOT in
        // `CUTOVER_DEFAULT_CLICKHOUSE`, and no CH client exists on prod today
        // (dormant guard returns "off"), so this branch is unreachable in
        // practice. Throwing keeps the resolver honest: a future flip to
        // "clickhouse" without a built twin must degrade via the caller's
        // error boundary, not silently re-run the heavy Postgres aggregate.
        throw new Error(
          "[past-deals] ClickHouse twin is not implemented for " +
            PAST_DEALS_SURFACE_KEY,
        );
      },
    });
  } catch (err) {
    console.error("[past-deals] hard failure — degrading to empty:", err);
    return {
      rows: [],
      totals: EMPTY_TOTALS,
      totalCount: 0,
      page: 1,
      totalPages: 1,
      backendUnavailable: true,
    };
  }
}

/**
 * The Postgres serve path for {@link getPastDeals}. Resilient: each heavy
 * leg is wrapped in `safeQuery` with a wall-clock timeout, so a slow scan
 * degrades to an empty / zero-filled fallback instead of failing the
 * page. Failures are logged via the safeQuery logger, never re-thrown.
 */
async function computePastDealsFromPostgres(
  page: number,
): Promise<PastDealsData> {
  const baseResult = await safeQuery(
    () => getEndedDealsBase(),
    { rows: [], backendUnavailable: true },
    "creator-hub.past-deals.base",
    PAST_DEALS_LEG_TIMEOUT_MS,
  );
  const base = baseResult.data;

  if (base.backendUnavailable) {
    return {
      rows: [],
      totals: EMPTY_TOTALS,
      totalCount: 0,
      page: 1,
      totalPages: 1,
      backendUnavailable: true,
    };
  }

  const allEnded = base.rows;
  const totalCount = allEnded.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAST_DEALS_PAGE_SIZE));
  const safePage = clampPage(page, totalPages);

  const sliceStart = (safePage - 1) * PAST_DEALS_PAGE_SIZE;
  const sliceEnd = sliceStart + PAST_DEALS_PAGE_SIZE;
  const pageBase = allEnded.slice(sliceStart, sliceEnd);

  if (pageBase.length === 0) {
    // No rows on this page → every money total is a page-scoped 0. Only the
    // count is full-set (drives pagination / "how many past deals exist").
    return {
      rows: [],
      totals: {
        ...EMPTY_TOTALS,
        totalEndedDeals: totalCount,
      },
      totalCount,
      page: safePage,
      totalPages,
      backendUnavailable: false,
    };
  }

  // Hydrate the page: usernames + per-board wager + per-board PnL. Each
  // helper is best-effort — wrapped in `safeQuery` with a wall-clock timeout
  // so a slow scan degrades the leg to its empty fallback (rows show id /
  // wager 0 / PnL 0) instead of sinking the whole page. Failures are logged
  // by the safeQuery wrapper, never re-thrown.
  const ownerIds = Array.from(new Set(pageBase.map((r) => r.userId)));
  const wagerInputs: LeaderboardWagerInput[] = pageBase.map((r) => ({
    id: r.boardId,
    creatorUserId: r.userId,
    coCreatorUserIds: r.coCreatorUserIds,
    affiliateCodes: r.affiliateCodes,
    startDate: new Date(r.frameStartMs),
    endDate: new Date(r.frameEndMs),
  }));
  const pnlInputs = pageBase.map((r) => ({
    boardId: r.boardId,
    creatorUserId: r.userId,
    startIso: new Date(r.frameStartMs).toISOString(),
    endIso: new Date(r.frameEndMs).toISOString(),
  }));

  type PnlEntry = {
    affiliatesMadeUs: number;
    deposits: number;
    cardWithdrawals: number;
    affiliateClaims: number;
  };
  const emptyCreatorMap = new Map<
    string,
    { username: string | null; image: string | null }
  >();
  const emptyWagerMap = new Map<string, number>();
  const emptyPnlMap = new Map<string, PnlEntry>();

  const [creatorRes, wagerRes, pnlRes] = await Promise.all([
    safeQuery(
      async () => {
        const db = await getDb();
        const creators = await db.user.findMany({
          where: { id: { in: ownerIds } },
          select: { id: true, username: true, image: true },
        });
        return new Map(
          creators.map((c) => [
            c.id,
            { username: c.username ?? null, image: c.image ?? null },
          ]),
        );
      },
      emptyCreatorMap,
      "creator-hub.past-deals.username",
      PAST_DEALS_LEG_TIMEOUT_MS,
    ),
    safeQuery(
      () => getCreatorLeaderboardWagerMap(wagerInputs),
      emptyWagerMap,
      "creator-hub.past-deals.wager",
      PAST_DEALS_LEG_TIMEOUT_MS,
    ),
    safeQuery(
      () => getBoardAffiliatePnl(pnlInputs),
      emptyPnlMap,
      "creator-hub.past-deals.pnl",
      PAST_DEALS_LEG_TIMEOUT_MS,
    ),
  ]);
  const creatorMap = creatorRes.data;
  const wagerMap = wagerRes.data;
  const pnlMap = pnlRes.data;

  const rows: PastDealRow[] = pageBase.map((r) => {
    const creator = creatorMap.get(r.userId);
    const actualWager = wagerMap.get(r.boardId) ?? 0;
    const affiliatesMadeUs = pnlMap.get(r.boardId)?.affiliatesMadeUs ?? 0;
    const expectedWager = r.dealCost / HOUSE_EDGE;
    const actualPnl = affiliatesMadeUs - r.dealCost;
    const conversionRate = expectedWager > 0 ? actualWager / expectedWager : 0;

    return {
      boardId: r.boardId,
      boardTitle: r.boardTitle,
      userId: r.userId,
      username: creator?.username ?? null,
      image: creator?.image ?? null,
      affiliateCodes: r.affiliateCodes,
      frameStartMs: r.frameStartMs,
      frameEndMs: r.frameEndMs,
      prizeUsd: r.prizeUsd,
      sponsoredPct: r.sponsoredPct,
      dealCost: r.dealCost,
      expectedWager,
      actualWager,
      affiliatesMadeUs,
      actualPnl,
      conversionRate,
    };
  });

  // Page-scope EVERY money total so the KPI strip is internally coherent:
  // cost, expected wager, wager, affiliates-made-us, PnL and conversion all
  // describe the SAME 25 boards the user sees in the rows below. Previously
  // cost + expected-wager were summed over the FULL ended set while the
  // wager/PnL/conversion legs were page-scoped — so the strip juxtaposed a
  // full-set Expected Wager (e.g. ~$754k across 141 boards) with a page
  // Wager (~$253k across 25) and a page PnL, which reads as the past deals
  // being wildly under-converting / mis-costed when it is only a scope
  // mismatch. Deriving every leg from `rows` keeps the whole strip on one
  // scope (and still honours Active-Timeframe-Only — page-bounded, no
  // heavy full-set wager/PnL scan). Only `totalEndedDeals` / `totalCount`
  // stay full-set (they drive pagination + "how many past deals exist").
  const pageCost = rows.reduce((s, r) => s + r.dealCost, 0);
  const pageExpectedWager = pageCost / HOUSE_EDGE;
  const pageCreatorWager = rows.reduce((s, r) => s + r.actualWager, 0);
  const pageAffiliatesMadeUs = rows.reduce((s, r) => s + r.affiliatesMadeUs, 0);
  const pageActualPnl = rows.reduce((s, r) => s + r.actualPnl, 0);
  const converting = rows.filter((r) => r.expectedWager > 0);
  const avgConversionRate =
    converting.length > 0
      ? converting.reduce((s, r) => s + r.conversionRate, 0) / converting.length
      : 0;

  return {
    rows,
    totals: {
      totalEndedDeals: totalCount,
      totalCost: pageCost,
      totalExpectedWager: pageExpectedWager,
      totalCreatorWager: pageCreatorWager,
      totalAffiliatesMadeUs: pageAffiliatesMadeUs,
      totalActualPnl: pageActualPnl,
      avgConversionRate,
    },
    totalCount,
    page: safePage,
    totalPages,
    backendUnavailable: false,
  };
}
