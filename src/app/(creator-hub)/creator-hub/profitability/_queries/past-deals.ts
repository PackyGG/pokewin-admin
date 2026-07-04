import "server-only";

import { unstable_cache } from "next/cache";

import { getDb } from "@/lib/db";
import { creatorsApi, type CreatorDealResponse } from "@/lib/backend-api";
import {
  affiliateLeaderboardsApi,
  type LeaderboardAdminRow,
} from "@/lib/backend-api/affiliate-leaderboards";
import { resolveAdminRead } from "@/lib/clickhouse/resolve-read";
import { safeQuery } from "@/lib/errors/safe-query";
import { getLeaderboardSponsorshipMap } from "../../../../(admin)/creators/_queries/leaderboard-sponsorship";
import { getBoardAffiliatePnl } from "./frame-affiliate-pnl-by-board";
import { getDealWagerByDeal } from "./frame-wager-by-deal";

/**
 * Creator Hub — Past Deals data.
 *
 * A PAST deal is the SAME entity as the Active tab (a `CreatorDealResponse`),
 * just ENDED: status `completed` (ran its full window) or `terminated` (cut
 * short). One row PER ended deal — a creator can have many (their deal
 * history), so the same creator appears once per ended deal.
 *
 * The per-leg cost mirrors the Active view's `deal-profitability.ts` EXACTLY:
 *
 *   dealWeeks     = round((endMs − startMs) / week), floored at 1 (weekly /
 *                   bi-weekly boards; a degenerate frame costs one week).
 *   capUsd        = weeklyCap(`total_withdraw_cap_usd`) × dealWeeks
 *                   (null cap → 0).
 *   tipSponsorUsd = (`max_tip_per_stream_usd` + `max_sponsorship_per_stream_usd`)
 *                   × `fills_allowed` × dealWeeks — the per-stream caps recur
 *                   for every fill the deal grants each week (owner directive
 *                   2026-06-23), scaled across the deal's weeks the same way
 *                   cap is.
 *   leaderboardUsd= Σ sponsored-weighted house cost of the creator's APPROVED
 *                   leaderboards whose run window OVERLAPS the deal window
 *                   (net prize × sponsored% / 100; default 100%). Boards and
 *                   deals are independent entities — most deals overlap no
 *                   board, so this leg is $0 for them (correct, not a gap).
 *   dealCost      = capUsd + leaderboardUsd + tipSponsorUsd.
 *   expectedWager = dealCost / house edge (7.5%).
 *   actualWager   = code-cohort wager inside the deal window (per-deal, keyed
 *                   so a creator's multiple ended deals don't collapse).
 *   affiliatesMadeUs = coverage-attributed cohort deposits − card withdrawals
 *                   − the creator's own affiliate_claim earnings, inside the
 *                   deal window (per-deal, `getBoardAffiliatePnl` keyed by
 *                   dealId).
 *   actualPnl     = affiliatesMadeUs − dealCost (house-profit convention).
 *   conversion    = actualWager / expectedWager (≥ 1× = the deal paid for
 *                   itself).
 *
 * ─── Effective window (CRITICAL for terminated deals) ────────────────────
 * start = `week_start_utc`. end depends on status:
 *   • completed  → `week_end_utc` (ran its full window).
 *   • terminated → min(`week_end_utc`, `updated_at`) — a terminated deal was
 *     cut short, and an open-ended deal carries a placeholder far-future
 *     `week_end_utc` (e.g. 2037). `updated_at` is the terminate action's
 *     write, so it is the real end. Without this clamp a terminated
 *     open-ended deal would cost `weeklyCap × ~575 weeks` — nonsense.
 *
 * ─── Fan-out (Active-Timeframe-Only) ─────────────────────────────────────
 * The base walk (cached ~5 min) fetches every creator's ended-deal history
 * (`creatorsApi.listDeals` for creators with `total_deals_count > 0`, via
 * `Promise.allSettled` so one failed fetch can't sink the page) + the
 * approved-board walk for the leaderboard leg. That is the LIGHT part
 * (identity, dates, cost). The HEAVY MAIN reads (wager + PnL) run only for
 * the 25 deals on the ACTIVE page, so a page flip never re-scans wager/PnL
 * for the whole ended set.
 *
 * Pagination is SERVER-SIDE via `?page=` (PAGE_SIZE = 25), sorted by end
 * DESC (most-recently ended first). Every MONEY KPI total is PAGE-SCOPED so
 * the strip is internally coherent with the 25 rows shown; only the ended
 * DEAL count is full-set (it drives pagination).
 */

/** Past deals per page. URL-driven via `?page=N`. */
export const PAST_DEALS_PAGE_SIZE = 25;
const HOUSE_EDGE = 0.075;
const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

/** Backend cap per request. */
const BACKEND_PAGE_SIZE = 100;
/** Per-creator deal-history walk cap (deal histories are a small bounded set). */
const DEAL_FETCH_CAP = 1000;
/** Cold-walk safety cap for the approved-board leaderboard leg. */
const BOARD_FETCH_CAP = 2000;

/**
 * Per-leg timeout (ms) for the page-scoped heavy reads. Long enough that a
 * healthy cold scan on prod-sized data completes (the per-deal PnL scan uses
 * a 55s `SET LOCAL statement_timeout` inside its own transaction); short
 * enough that a pathological hang degrades to the empty-state card instead
 * of running out the function budget on Vercel and surfacing as a 500.
 */
const PAST_DEALS_LEG_TIMEOUT_MS = 60_000;

/**
 * `resolveAdminRead` surface key for the past-deals page-scoped compute.
 *
 * Sits in the dormant state (NOT in `CUTOVER_DEFAULT_CLICKHOUSE`): with no
 * ClickHouse client provisioned the resolver returns `"off"` and the surface
 * serves Postgres unchanged. Wiring the call through `resolveAdminRead`
 * satisfies the Index-or-ClickHouse construct so a CH twin can later be
 * dropped in without re-plumbing the page. The `ch` leg throws by design —
 * it is unreachable today, and on a future flip without a built twin the
 * resolver THROWS so the page's empty-state path is taken.
 */
const PAST_DEALS_SURFACE_KEY = "creator_hub_profitability_past_deals";

/**
 * Whole weeks in a deal frame — used to scale the per-week withdraw cap +
 * tip/sponsor allowance over the deal length. Boards run in weekly multiples
 * (weekly / bi-weekly), so the duration is rounded to the nearest week and
 * floored at 1. Mirrors `frameWeeks` in `deal-profitability.ts` exactly.
 */
function frameWeeks(startMs: number, endMs: number): number {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return 1;
  }
  return Math.max(1, Math.round((endMs - startMs) / MS_PER_WEEK));
}

function toFiniteNumber(value: string | number | null | undefined): number {
  if (value == null) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

export type PastDealRow = {
  /** Backend deal id (= the past deal id, stable, map key). */
  dealId: string;
  /** Primary owner's user id. */
  userId: string;
  /** Resolved owner username (MAIN read), or null when unresolved. */
  username: string | null;
  /** Owner's profile image (MAIN read), or null when unresolved. */
  image: string | null;
  /** Ended-deal status — `completed` (full run) or `terminated` (cut short). */
  status: "completed" | "terminated";
  /** Effective frame start (epoch ms) — the deal's `week_start_utc`. */
  frameStartMs: number;
  /** Effective frame end (epoch ms) — see the effective-window note above. */
  frameEndMs: number;
  /** Whole weeks in the effective deal frame. */
  dealWeeks: number;
  /** Per-week withdraw cap from the deal (`total_withdraw_cap_usd`; 0 when uncapped). */
  weeklyCapUsd: number;
  /** Total withdraw cap over the deal length (`weeklyCapUsd × dealWeeks`). */
  capUsd: number;
  /** Per-week tip + sponsor allowance (`(tip + sponsor) × fills_allowed`). */
  weeklyTipSponsorUsd: number;
  /** Total tip + sponsor allowance over the deal length (`weekly × dealWeeks`). */
  tipSponsorUsd: number;
  /** Sponsored-weighted house cost of the creator's boards overlapping the window (rose). */
  leaderboardUsd: number;
  /** capUsd + leaderboardUsd + tipSponsorUsd (rose house cost). */
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
  /** Avg conversion across page deals with expectedWager > 0. */
  avgConversionRate: number;
};

export type PastDealsData = {
  /** Current-page rows (≤ PAST_DEALS_PAGE_SIZE). */
  rows: PastDealRow[];
  /**
   * KPI-strip aggregates. Every MONEY total (cost, expected wager, wager,
   * affiliates-made-us, PnL, conversion) is PAGE-SCOPED — it describes the
   * same 25 deals in `rows` so the strip is internally coherent. Only
   * `totalEndedDeals` (+ `totalCount`) is full-set.
   */
  totals: PastDealsTotals;
  /** Total ended deals (for pagination footer). */
  totalCount: number;
  /** 1-based current page (clamped to valid range). */
  page: number;
  /** Total page count (≥ 1). */
  totalPages: number;
  /** True when the backend deal walk failed (UI shows empty). */
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

/** One approved board's window + sponsored-weighted house cost, for overlap. */
type BoardCostWindow = {
  creatorUserId: string;
  startMs: number;
  endMs: number;
  houseCostUsd: number;
};

/** The light, cacheable per-deal base row (identity + cost legs, no MAIN reads). */
type PastDealBaseRow = {
  dealId: string;
  userId: string;
  status: "completed" | "terminated";
  frameStartMs: number;
  frameEndMs: number;
  dealWeeks: number;
  weeklyCapUsd: number;
  capUsd: number;
  weeklyTipSponsorUsd: number;
  tipSponsorUsd: number;
  leaderboardUsd: number;
  dealCost: number;
};

/**
 * Effective end (epoch ms) of an ended deal. `completed` deals ran their
 * full window (`week_end_utc`); `terminated` deals were cut short, and an
 * open-ended deal carries a placeholder far-future `week_end_utc`, so the
 * real end is the terminate action's write (`updated_at`) — clamped to
 * never exceed `week_end_utc`.
 */
function effectiveEndMs(deal: CreatorDealResponse): number {
  const weekEndMs = Date.parse(deal.week_end_utc);
  if (deal.status !== "terminated") return weekEndMs;
  const updatedMs = Date.parse(deal.updated_at);
  if (!Number.isFinite(updatedMs)) return weekEndMs;
  if (!Number.isFinite(weekEndMs)) return updatedMs;
  return Math.min(weekEndMs, updatedMs);
}

/** Walk every APPROVED leaderboard, first-page-then-parallel, up to the cap. */
async function walkAllApprovedLeaderboards(): Promise<LeaderboardAdminRow[]> {
  const firstPage = await affiliateLeaderboardsApi.list({
    status: "approved",
    offset: 0,
    limit: BACKEND_PAGE_SIZE,
  });
  const all: LeaderboardAdminRow[] = [...firstPage.leaderboards];
  const pagesNeeded = Math.min(
    Math.ceil(BOARD_FETCH_CAP / BACKEND_PAGE_SIZE),
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
  for (const page of await Promise.all(rest)) all.push(...page.leaderboards);
  return all;
}

/** Fetch one creator's FULL deal history, paging the backend. */
async function fetchAllDealsForCreator(
  userId: string,
): Promise<CreatorDealResponse[]> {
  const firstPage = await creatorsApi.listDeals(userId, {
    offset: 0,
    limit: BACKEND_PAGE_SIZE,
  });
  const all: CreatorDealResponse[] = [...firstPage.data];
  const pagesNeeded = Math.min(
    Math.ceil(DEAL_FETCH_CAP / BACKEND_PAGE_SIZE),
    Math.ceil(firstPage.total / BACKEND_PAGE_SIZE),
  );
  const rest: Promise<typeof firstPage>[] = [];
  for (let p = 1; p < pagesNeeded; p++) {
    rest.push(
      creatorsApi.listDeals(userId, {
        offset: p * BACKEND_PAGE_SIZE,
        limit: BACKEND_PAGE_SIZE,
      }),
    );
  }
  for (const page of await Promise.all(rest)) all.push(...page.data);
  return all;
}

/**
 * Cached ended-deal base walk + per-deal cost legs (cap + tip/sponsor + the
 * sponsored-weighted leaderboard-overlap leg). This is the LIGHT part;
 * wager + PnL are computed per-page (heavy MAIN reads) AFTER this returns so
 * the cache stays small and reusable across page flips.
 */
const getEndedDealsBase = unstable_cache(
  async (): Promise<{ rows: PastDealBaseRow[]; backendUnavailable: boolean }> => {
    // Roster → creators with any deal history. One walk (paged in parallel).
    let roster;
    try {
      const firstPage = await creatorsApi.list({
        offset: 0,
        limit: BACKEND_PAGE_SIZE,
      });
      const all = [...firstPage.data];
      const pagesNeeded = Math.ceil(firstPage.total / BACKEND_PAGE_SIZE);
      const rest = [];
      for (let p = 1; p < pagesNeeded; p++) {
        rest.push(
          creatorsApi.list({ offset: p * BACKEND_PAGE_SIZE, limit: BACKEND_PAGE_SIZE }),
        );
      }
      for (const page of await Promise.all(rest)) all.push(...page.data);
      roster = all;
    } catch (e) {
      console.error("[past-deals] creator roster walk failed (page empty):", e);
      return { rows: [], backendUnavailable: true };
    }

    // Only fan out deal history for creators that HAVE deals.
    const dealCreators = roster.filter((c) => (c.total_deals_count ?? 0) > 0);

    // Approved-board walk + sponsorship, for the leaderboard-overlap leg.
    // Best-effort: a failed walk drops the LB leg (0) rather than blanking
    // the whole page (cap + tip/sponsor legs still cost the deal).
    let boardWindows: BoardCostWindow[] = [];
    try {
      const boards = await walkAllApprovedLeaderboards();
      let sponsorship: Map<string, number>;
      try {
        sponsorship = await getLeaderboardSponsorshipMap(
          boards.map((lb) => lb.id),
        );
      } catch (e) {
        console.error(
          "[past-deals] sponsorship lookup failed (treating all as 100%):",
          e,
        );
        sponsorship = new Map();
      }
      boardWindows = boards
        .map((lb) => {
          const startMs = Date.parse(lb.start_date);
          const endMs = Date.parse(lb.end_date);
          const prize = Number(lb.total_prize_usd) || 0;
          const refund = Number(lb.refund_amount_usd) || 0;
          const net = prize - refund;
          const pct = Math.min(100, Math.max(0, sponsorship.get(lb.id) ?? 100));
          return {
            creatorUserId: lb.creator_user_id,
            startMs,
            endMs,
            houseCostUsd: net * (pct / 100),
          };
        })
        .filter((b) => Number.isFinite(b.startMs) && Number.isFinite(b.endMs));
    } catch (e) {
      console.error(
        "[past-deals] approved-board walk failed (LB leg drops to 0):",
        e,
      );
      boardWindows = [];
    }

    // Fan out every deal-history fetch in parallel; one creator's failed
    // fetch can't sink the page (allSettled).
    const settled = await Promise.allSettled(
      dealCreators.map((c) => fetchAllDealsForCreator(c.id)),
    );

    const ended: PastDealBaseRow[] = [];
    settled.forEach((outcome, i) => {
      const creator = dealCreators[i];
      if (outcome.status !== "fulfilled") {
        console.error(
          `[past-deals] listDeals failed for creator ${creator.id} (its deals are omitted):`,
          outcome.reason,
        );
        return;
      }
      for (const deal of outcome.value) {
        if (deal.status !== "completed" && deal.status !== "terminated") {
          continue; // scheduled / active belong to the Active tab
        }
        const startMs = Date.parse(deal.week_start_utc);
        const endMs = effectiveEndMs(deal);
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;

        const dealWeeks = frameWeeks(startMs, endMs);
        const weeklyCapUsd = toFiniteNumber(deal.total_withdraw_cap_usd);
        const capUsd = weeklyCapUsd * dealWeeks;
        const perStreamTip = toFiniteNumber(deal.max_tip_per_stream_usd);
        const perStreamSponsor = toFiniteNumber(
          deal.max_sponsorship_per_stream_usd,
        );
        const fillsAllowed = Math.max(0, deal.fills_allowed ?? 0);
        const weeklyTipSponsorUsd =
          (perStreamTip + perStreamSponsor) * fillsAllowed;
        const tipSponsorUsd = weeklyTipSponsorUsd * dealWeeks;

        // Leaderboard leg: Σ sponsored-weighted house cost of the creator's
        // approved boards whose run window overlaps this deal's window.
        let leaderboardUsd = 0;
        for (const b of boardWindows) {
          if (b.creatorUserId !== creator.id) continue;
          if (b.startMs <= endMs && b.endMs >= startMs) {
            leaderboardUsd += b.houseCostUsd;
          }
        }

        const dealCost = capUsd + leaderboardUsd + tipSponsorUsd;

        ended.push({
          dealId: deal.id,
          userId: creator.id,
          status: deal.status,
          frameStartMs: startMs,
          frameEndMs: endMs,
          dealWeeks,
          weeklyCapUsd,
          capUsd,
          weeklyTipSponsorUsd,
          tipSponsorUsd,
          leaderboardUsd,
          dealCost,
        });
      }
    });

    // Most-recently ended first (the default sort).
    ended.sort((a, b) => b.frameEndMs - a.frameEndMs);
    return { rows: ended, backendUnavailable: false };
  },
  ["profitability-past-deals-base-v2"],
  { revalidate: 300, tags: ["profitability-past-deals"] },
);

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
 * Page-scoped: heavy MAIN reads (wager + PnL) only run for the 25 deals on
 * the active page (Active-Timeframe-Only). The KPI-strip money totals are
 * therefore ALL page-scoped so the strip stays internally coherent; only the
 * ended-deal COUNT is full-set.
 *
 * Routed through `resolveAdminRead` (Index-or-ClickHouse construct). With no
 * ClickHouse twin built, the surface stays dormant; the resolver returns the
 * `pg()` value. The `pg` leg uses `safeQuery` per heavy leg so a slow scan
 * degrades the leg to its fallback instead of taking down the request.
 */
export async function getPastDeals(page: number): Promise<PastDealsData> {
  try {
    return await resolveAdminRead(PAST_DEALS_SURFACE_KEY, {
      pg: () => computePastDealsFromPostgres(page),
      ch: () => {
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
 * degrades to an empty / zero-filled fallback instead of failing the page.
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
  const pageBase = allEnded.slice(sliceStart, sliceStart + PAST_DEALS_PAGE_SIZE);

  if (pageBase.length === 0) {
    return {
      rows: [],
      totals: { ...EMPTY_TOTALS, totalEndedDeals: totalCount },
      totalCount,
      page: safePage,
      totalPages,
      backendUnavailable: false,
    };
  }

  // Hydrate the page: usernames + per-deal wager + per-deal PnL. Each helper
  // is best-effort — wrapped in `safeQuery` with a wall-clock timeout so a
  // slow scan degrades the leg to its empty fallback (rows show id / wager 0
  // / PnL 0) instead of sinking the whole page.
  const ownerIds = Array.from(new Set(pageBase.map((r) => r.userId)));
  const wagerInputs = pageBase.map((r) => ({
    dealId: r.dealId,
    creatorUserId: r.userId,
    startIso: new Date(r.frameStartMs).toISOString(),
    endIso: new Date(r.frameEndMs).toISOString(),
  }));
  const pnlInputs = pageBase.map((r) => ({
    boardId: r.dealId, // getBoardAffiliatePnl is keyed by an arbitrary window id
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
      () => getDealWagerByDeal(wagerInputs),
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
    const actualWager = wagerMap.get(r.dealId) ?? 0;
    const affiliatesMadeUs = pnlMap.get(r.dealId)?.affiliatesMadeUs ?? 0;
    const expectedWager = r.dealCost / HOUSE_EDGE;
    const actualPnl = affiliatesMadeUs - r.dealCost;
    const conversionRate = expectedWager > 0 ? actualWager / expectedWager : 0;

    return {
      dealId: r.dealId,
      userId: r.userId,
      username: creator?.username ?? null,
      image: creator?.image ?? null,
      status: r.status,
      frameStartMs: r.frameStartMs,
      frameEndMs: r.frameEndMs,
      dealWeeks: r.dealWeeks,
      weeklyCapUsd: r.weeklyCapUsd,
      capUsd: r.capUsd,
      weeklyTipSponsorUsd: r.weeklyTipSponsorUsd,
      tipSponsorUsd: r.tipSponsorUsd,
      leaderboardUsd: r.leaderboardUsd,
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
  // describe the SAME 25 deals in the rows below. Only `totalEndedDeals` /
  // `totalCount` stay full-set (they drive pagination + "how many exist").
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
