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
 * A PAST deal is an ENDED LEADERBOARD FRAME — the SAME entity the Active tab
 * uses (the owner's model: "the leaderboard window IS the deal";
 * `getActiveLeaderboardFrameByUser` in `leaderboard-cost.ts`). A frame is
 * weekly OR bi-weekly; a bi-weekly frame spans two weekly backend deals, so
 * the frame — not a single weekly `CreatorDealResponse` — is the unit of
 * length, past-detection and cost.
 *
 *   • PAST-DETECTION: a frame is past iff its `end_date < now`. A frame still
 *     running (end_date ≥ now) is NOT a past deal — it belongs to Active.
 *     (Anchoring to the weekly backend deal wrongly marked a live bi-weekly
 *     frame as "completed · 7 days ended" — the bug this rebuild fixes.)
 *   • LENGTH / WINDOW: the FULL frame `[start_date, end_date]` (bi-weekly =
 *     14 days), never a single 7-day weekly deal window.
 *   • COST TERMS: pulled from the creator's backend deal that OVERLAPS the
 *     frame (per_fill / cap / tip / sponsor). Every cost leg scales over the
 *     FULL frame duration.
 *
 * Per-leg cost (the cap / tip-sponsor legs mirror the Active view's
 * `deal-profitability.ts`; the DAILY BALANCE FILL leg is the dominant cost —
 * owner directive 2026-07-05 — and MUST scale across the full frame):
 *
 *   frameWeeks    = round((endMs − startMs) / week), floored at 1.
 *   frameDays     = round((endMs − startMs) / day), floored at 1.
 *   fillUsd       = `per_fill_amount_usd` × frameDays — the daily balance fill
 *                   loaded once per day across the WHOLE frame. Verified vs
 *                   prod (2026-07-05): a 7-day frame's deal grants
 *                   `fills_allowed = 7` (one fill/day); `per_fill_amount_usd`
 *                   IS the daily balance-fill amount. Scaled by frame DAYS
 *                   (not the weekly deal's `fills_allowed`) so a bi-weekly
 *                   frame counts 14 daily fills, not 7 (owner directive
 *                   2026-07-05).
 *   capUsd        = weeklyCap(`total_withdraw_cap_usd`) × frameWeeks (null → 0).
 *   tipSponsorUsd = (`max_tip_per_stream_usd` + `max_sponsorship_per_stream_usd`)
 *                   × `fills_allowed` × frameWeeks — per-stream caps recur for
 *                   every fill the deal grants each week (owner directive
 *                   2026-06-23), scaled across the frame's weeks like cap.
 *   leaderboardUsd= the frame's OWN sponsored-weighted house cost
 *                   (net prize × sponsored% / 100; default 100%) — this IS the
 *                   board, so its full committed house cost is the LB leg.
 *   dealCost      = fillUsd + capUsd + leaderboardUsd + tipSponsorUsd.
 *   expectedWager = dealCost / house edge (7.5%).
 *   actualWager   = code-cohort wager inside the frame window (per-frame, keyed
 *                   by board id so a creator's multiple past frames don't
 *                   collapse).
 *   affiliatesMadeUs = coverage-attributed cohort deposits − card withdrawals
 *                   − the creator's own affiliate_claim earnings, inside the
 *                   frame window (per-frame, `getBoardAffiliatePnl` keyed by
 *                   board id).
 *   actualPnl     = affiliatesMadeUs − dealCost (house-profit convention).
 *   conversion    = actualWager / expectedWager (≥ 1× = the deal paid for
 *                   itself).
 *
 * ─── Overlapping-deal terms ──────────────────────────────────────────────
 * Each ended frame is costed from the creator's backend deal whose window
 * overlaps the frame. When several overlap (a bi-weekly frame spanning two
 * weekly deals), the one with the LARGEST overlap wins — its terms represent
 * the frame's cadence, and the fill/cap/tip legs are then scaled over the
 * frame's full days/weeks (so both weeks are counted). A frame with NO
 * overlapping deal has no deal-term legs (fill / cap / tip = 0); only its LB
 * leg costs — it is still a real ended board.
 *
 * ─── Fan-out (Active-Timeframe-Only) ─────────────────────────────────────
 * The base walk (cached ~5 min) fetches every APPROVED leaderboard + each
 * deal-bearing creator's deal history (`creatorsApi.listDeals`, via
 * `Promise.allSettled` so one failed fetch can't sink the page). That is the
 * LIGHT part (identity, dates, cost). The HEAVY MAIN reads (wager + PnL) run
 * only for the 25 frames on the ACTIVE page, so a page flip never re-scans
 * wager/PnL for the whole ended set.
 *
 * Pagination is SERVER-SIDE via `?page=` (PAGE_SIZE = 25), sorted by frame
 * end DESC (most-recently ended first). Every MONEY KPI total is PAGE-SCOPED
 * so the strip is internally coherent with the 25 rows shown; only the ended
 * DEAL count is full-set (it drives pagination).
 */

/** Past deals per page. URL-driven via `?page=N`. */
export const PAST_DEALS_PAGE_SIZE = 25;
const HOUSE_EDGE = 0.075;
const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Backend cap per request. */
const BACKEND_PAGE_SIZE = 100;
/** Per-creator deal-history walk cap (deal histories are a small bounded set). */
const DEAL_FETCH_CAP = 1000;
/** Cold-walk safety cap for the approved-board walk. */
const BOARD_FETCH_CAP = 2000;

/**
 * Per-leg timeout (ms) for the page-scoped heavy reads. Long enough that a
 * healthy cold scan on prod-sized data completes (the per-frame PnL scan uses
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
 * Whole weeks in a frame — used to scale the per-week withdraw cap +
 * tip/sponsor allowance over the frame length. Boards run in weekly multiples
 * (weekly / bi-weekly), so the duration is rounded to the nearest week and
 * floored at 1. Mirrors `frameWeeks` in `deal-profitability.ts`.
 */
function frameWeeks(startMs: number, endMs: number): number {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return 1;
  }
  return Math.max(1, Math.round((endMs - startMs) / MS_PER_WEEK));
}

/**
 * Whole days in a frame — used to scale the daily balance fill over the frame
 * length. Rounded to the nearest day and floored at 1 (a degenerate /
 * same-day frame is one fill, never zero).
 */
function frameDays(startMs: number, endMs: number): number {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return 1;
  }
  return Math.max(1, Math.round((endMs - startMs) / MS_PER_DAY));
}

function toFiniteNumber(value: string | number | null | undefined): number {
  if (value == null) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

export type PastDealRow = {
  /** Backend leaderboard (frame) id — the past deal id, stable, map key. */
  boardId: string;
  /** Frame title (the board's display name). */
  boardTitle: string;
  /** Primary owner's user id. */
  userId: string;
  /** Resolved owner username (MAIN read), or null when unresolved. */
  username: string | null;
  /** Owner's profile image (MAIN read), or null when unresolved. */
  image: string | null;
  /** Affiliate codes that fed the frame (for reference / cohort). */
  affiliateCodes: string[];
  /** Frame start (epoch ms) — the board's `start_date`. */
  frameStartMs: number;
  /** Frame end (epoch ms) — the board's `end_date` (strictly in the past). */
  frameEndMs: number;
  /** Whole weeks in the frame. */
  dealWeeks: number;
  /** Whole days in the frame (drives the daily-fill leg). */
  dealDays: number;
  /** Daily balance-fill amount from the overlapping deal (0 when no deal). */
  perFillUsd: number;
  /** Number of daily fills counted = frameDays (0 when no per-fill amount). */
  fillsCounted: number;
  /** Total daily-fill cost over the frame (`perFillUsd × frameDays`, rose). */
  fillUsd: number;
  /** Per-week withdraw cap from the overlapping deal (0 when uncapped / no deal). */
  weeklyCapUsd: number;
  /** Total withdraw cap over the frame (`weeklyCapUsd × dealWeeks`). */
  capUsd: number;
  /** Per-week tip + sponsor allowance (`(tip + sponsor) × fills_allowed`). */
  weeklyTipSponsorUsd: number;
  /** Total tip + sponsor allowance over the frame (`weekly × dealWeeks`). */
  tipSponsorUsd: number;
  /** The frame's sponsored-weighted house cost (net prize × sponsored%, rose). */
  leaderboardUsd: number;
  /** fillUsd + capUsd + leaderboardUsd + tipSponsorUsd (rose house cost). */
  dealCost: number;
  expectedWager: number;
  actualWager: number;
  /** Coverage-attributed deposits − card withdrawals − affiliate claims, this frame. */
  affiliatesMadeUs: number;
  /** `affiliatesMadeUs − dealCost` (house-profit convention). */
  actualPnl: number;
  /** `expectedWager > 0 ? actualWager / expectedWager : 0`. */
  conversionRate: number;
};

export type PastDealsTotals = {
  /** Total ended frames across the FULL set (drives pagination) — NOT page-scoped. */
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
  /** Avg conversion across page frames with expectedWager > 0. */
  avgConversionRate: number;
};

export type PastDealsData = {
  /** Current-page rows (≤ PAST_DEALS_PAGE_SIZE). */
  rows: PastDealRow[];
  /**
   * KPI-strip aggregates. Every MONEY total (cost, expected wager, wager,
   * affiliates-made-us, PnL, conversion) is PAGE-SCOPED — it describes the
   * same 25 frames in `rows` so the strip is internally coherent. Only
   * `totalEndedDeals` (+ `totalCount`) is full-set.
   */
  totals: PastDealsTotals;
  /** Total ended frames (for pagination footer). */
  totalCount: number;
  /** 1-based current page (clamped to valid range). */
  page: number;
  /** Total page count (≥ 1). */
  totalPages: number;
  /** True when the backend frame walk failed (UI shows empty). */
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

/** The light, cacheable per-frame base row (identity + cost legs, no MAIN reads). */
type PastDealBaseRow = {
  boardId: string;
  boardTitle: string;
  userId: string;
  coCreatorUserIds: string[];
  affiliateCodes: string[];
  frameStartMs: number;
  frameEndMs: number;
  dealWeeks: number;
  dealDays: number;
  perFillUsd: number;
  fillsCounted: number;
  fillUsd: number;
  weeklyCapUsd: number;
  capUsd: number;
  weeklyTipSponsorUsd: number;
  tipSponsorUsd: number;
  leaderboardUsd: number;
  dealCost: number;
};

/** Cost terms pulled from the creator's deal that best overlaps a frame. */
type DealTerms = {
  perFillUsd: number;
  weeklyCapUsd: number;
  perStreamTip: number;
  perStreamSponsor: number;
  fillsAllowed: number;
};

const ZERO_TERMS: DealTerms = {
  perFillUsd: 0,
  weeklyCapUsd: 0,
  perStreamTip: 0,
  perStreamSponsor: 0,
  fillsAllowed: 0,
};

/**
 * Pick the deal whose window overlaps a frame the MOST. A bi-weekly frame can
 * overlap two weekly deals; the largest-overlap deal's terms represent the
 * frame's cadence (the fill/cap/tip legs are then scaled over the FULL frame
 * days/weeks by the caller). Returns null when no deal overlaps the frame.
 */
function bestOverlappingDeal(
  frameStartMs: number,
  frameEndMs: number,
  deals: CreatorDealResponse[],
): CreatorDealResponse | null {
  let best: CreatorDealResponse | null = null;
  let bestOverlap = 0;
  for (const d of deals) {
    const ds = Date.parse(d.week_start_utc);
    const de = Date.parse(d.week_end_utc);
    if (!Number.isFinite(ds) || !Number.isFinite(de)) continue;
    const overlap =
      Math.min(frameEndMs, de) - Math.max(frameStartMs, ds);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = d;
    }
  }
  return best;
}

function termsFromDeal(deal: CreatorDealResponse | null): DealTerms {
  if (!deal) return ZERO_TERMS;
  return {
    perFillUsd: toFiniteNumber(deal.per_fill_amount_usd),
    weeklyCapUsd: toFiniteNumber(deal.total_withdraw_cap_usd),
    perStreamTip: toFiniteNumber(deal.max_tip_per_stream_usd),
    perStreamSponsor: toFiniteNumber(deal.max_sponsorship_per_stream_usd),
    fillsAllowed: Math.max(0, deal.fills_allowed ?? 0),
  };
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
 * Cached ended-frame base walk + per-frame cost legs. This is the LIGHT part;
 * wager + PnL are computed per-page (heavy MAIN reads) AFTER this returns so
 * the cache stays small and reusable across page flips.
 */
const getEndedDealsBase = unstable_cache(
  async (): Promise<{ rows: PastDealBaseRow[]; backendUnavailable: boolean }> => {
    // Every APPROVED leaderboard (the frames).
    let all: LeaderboardAdminRow[];
    try {
      all = await walkAllApprovedLeaderboards();
    } catch (e) {
      console.error("[past-deals] approved-board walk failed (page empty):", e);
      return { rows: [], backendUnavailable: true };
    }

    // Sponsored % per frame (the LB leg's house-share weighting).
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

    // Ended frames only — the whole point of past-detection: a frame is past
    // iff its end_date is strictly in the past. A LIVE / upcoming frame
    // (end ≥ now) is NOT a past deal (it belongs to Active).
    const endedFrames = all.filter((lb) => {
      const endMs = Date.parse(lb.end_date);
      return Number.isFinite(endMs) && endMs < now;
    });

    if (endedFrames.length === 0) {
      return { rows: [], backendUnavailable: false };
    }

    // Deal terms live per creator — fetch each frame-owner's deal history once
    // (allSettled so one failed fetch can't sink the page), then match each
    // frame to its best-overlapping deal for the cost terms.
    const ownerIds = Array.from(
      new Set(endedFrames.map((lb) => lb.creator_user_id)),
    );
    const settled = await Promise.allSettled(
      ownerIds.map((id) => fetchAllDealsForCreator(id)),
    );
    const dealsByOwner = new Map<string, CreatorDealResponse[]>();
    settled.forEach((outcome, i) => {
      if (outcome.status === "fulfilled") {
        dealsByOwner.set(ownerIds[i], outcome.value);
      } else {
        console.error(
          `[past-deals] listDeals failed for creator ${ownerIds[i]} (its frames cost only the LB leg):`,
          outcome.reason,
        );
        dealsByOwner.set(ownerIds[i], []);
      }
    });

    const ended: PastDealBaseRow[] = [];
    for (const lb of endedFrames) {
      const startMs = Date.parse(lb.start_date);
      const endMs = Date.parse(lb.end_date);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;

      const dealWeeks = frameWeeks(startMs, endMs);
      const dealDays = frameDays(startMs, endMs);

      // Cost terms from the creator's deal that best overlaps THIS frame.
      const deals = dealsByOwner.get(lb.creator_user_id) ?? [];
      const terms = termsFromDeal(
        bestOverlappingDeal(startMs, endMs, deals),
      );

      // Daily balance fill scaled over the WHOLE frame (owner directive
      // 2026-07-05): one fill per day across the frame's days — a bi-weekly
      // (14-day) frame counts 14 daily fills, not the weekly deal's 7.
      const perFillUsd = terms.perFillUsd;
      const fillsCounted = perFillUsd > 0 ? dealDays : 0;
      const fillUsd = perFillUsd * fillsCounted;

      const weeklyCapUsd = terms.weeklyCapUsd;
      const capUsd = weeklyCapUsd * dealWeeks;
      const weeklyTipSponsorUsd =
        (terms.perStreamTip + terms.perStreamSponsor) * terms.fillsAllowed;
      const tipSponsorUsd = weeklyTipSponsorUsd * dealWeeks;

      // The frame's own sponsored-weighted house cost — this board IS the
      // deal, so its full committed house cost is the LB leg.
      const prize = Number(lb.total_prize_usd) || 0;
      const refund = Number(lb.refund_amount_usd) || 0;
      const net = prize - refund;
      const pct = Math.min(100, Math.max(0, sponsorship.get(lb.id) ?? 100));
      const leaderboardUsd = net * (pct / 100);

      const dealCost = fillUsd + capUsd + leaderboardUsd + tipSponsorUsd;

      ended.push({
        boardId: lb.id,
        boardTitle: lb.title,
        userId: lb.creator_user_id,
        coCreatorUserIds: lb.co_creator_user_ids ?? [],
        affiliateCodes: lb.affiliate_codes ?? [],
        frameStartMs: startMs,
        frameEndMs: endMs,
        dealWeeks,
        dealDays,
        perFillUsd,
        fillsCounted,
        fillUsd,
        weeklyCapUsd,
        capUsd,
        weeklyTipSponsorUsd,
        tipSponsorUsd,
        leaderboardUsd,
        dealCost,
      });
    }

    // Most-recently ended first (the default sort).
    ended.sort((a, b) => b.frameEndMs - a.frameEndMs);
    return { rows: ended, backendUnavailable: false };
  },
  ["profitability-past-deals-base-v4"],
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
 * Page-scoped: heavy MAIN reads (wager + PnL) only run for the 25 frames on
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

  // Hydrate the page: usernames + per-frame wager + per-frame PnL. Each helper
  // is best-effort — wrapped in `safeQuery` with a wall-clock timeout so a
  // slow scan degrades the leg to its empty fallback (rows show id / wager 0
  // / PnL 0) instead of sinking the whole page.
  const ownerIds = Array.from(new Set(pageBase.map((r) => r.userId)));
  const wagerInputs = pageBase.map((r) => ({
    dealId: r.boardId, // wager helper keys by an arbitrary window id
    creatorUserId: r.userId,
    startIso: new Date(r.frameStartMs).toISOString(),
    endIso: new Date(r.frameEndMs).toISOString(),
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
      dealWeeks: r.dealWeeks,
      dealDays: r.dealDays,
      perFillUsd: r.perFillUsd,
      fillsCounted: r.fillsCounted,
      fillUsd: r.fillUsd,
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
  // describe the SAME 25 frames in the rows below. Only `totalEndedDeals` /
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
