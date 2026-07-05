import "server-only";

import { unstable_cache } from "next/cache";

import { creatorsApi, type CreatorDealResponse } from "@/lib/backend-api";
import type { LeaderboardAdminRow } from "@/lib/backend-api/affiliate-leaderboards";
import { safeQuery } from "@/lib/errors/safe-query";

import { fetchAllApprovedLeaderboards } from "../../../(admin)/creators/_queries/leaderboard-cost";
import {
  getDealWagerByDeal,
  type DealWagerWindow,
} from "../profitability/_queries/frame-wager-by-deal";

/**
 * Creator Hub — "4 Weeks" summary.
 *
 * A FIXED rolling 28-day window `[now − 28d, now]`. Frame-centric (the owner's
 * model: "a leaderboard frame IS the deal"): every APPROVED affiliate
 * leaderboard whose run window OVERLAPS the 28-day window contributes. That is
 * ended-within-window, currently-live, and spanning frames — anything with
 * `startMs <= now && endMs >= (now − 28d)`. Purely-future (start > now) and
 * fully-past (end < now−28d) frames are excluded.
 *
 * Per-frame cost is the ACTIVE-tab model (NO daily-fill leg, FULL net
 * leaderboard prize — owner directive 2026-07-05):
 *
 *   dealWeeks        = frameWeeks(startMs, endMs)                       (≥ 1)
 *   weeklyCapUsd     = toFiniteNumber(deal.total_withdraw_cap_usd)      (0 uncapped)
 *   capUsd           = weeklyCapUsd × dealWeeks
 *   weeklyTipSponsor = (tip + sponsor) × max(0, fills_allowed)
 *   tipSponsorUsd    = weeklyTipSponsor × dealWeeks
 *   leaderboardUsd   = max(0, net prize − refund)   (FULL net, NOT sponsored-weighted)
 *   dealCost         = capUsd + leaderboardUsd + tipSponsorUsd          (NO fill leg)
 *   expectedWager    = dealCost / 0.075                                 (house edge)
 *
 * A frame with NO overlapping deal contributes only its leaderboardUsd leg
 * (cap / tip = 0) and NO conversion sample.
 *
 * Actual wager is summed via `getDealWagerByDeal` over a per-frame window
 * clipped at `now` (`[startMs, min(endMs, now)]`).
 *
 * The FOUR tile values:
 *   • activeCreators   = distinct `creator_user_id` across in-window frames.
 *   • expectedWagerUsd = Σ expectedWager over in-window frames.
 *   • actualWagerUsd   = Σ getDealWagerByDeal over in-window frames.
 *   • avgConversionPct = mean over frames WITH an overlapping deal of
 *                        `deal.conversion_rate_bps / 100` (configured rate,
 *                        NOT actual/expected).
 *
 * Fan-out mirrors Past Deals: a cached base compute (approved-board walk +
 * per-owner deal-history via `Promise.allSettled(fetchAllDealsForCreator)` +
 * per-frame cost legs + wager windows) runs the LIGHT part; the HEAVY MAIN
 * read (`getDealWagerByDeal`) runs AFTER the cache returns. `now` is computed
 * INSIDE the cached fn (same as Past Deals). All money is Decimal-safe (the
 * shared helpers coerce backend strings via `Number` / `toFiniteNumber`).
 */

const HOUSE_EDGE = 0.075;
const MS_PER_28D = 28 * 24 * 60 * 60 * 1000;

/**
 * Per-leg timeout (ms). Long enough for a healthy cold board-walk +
 * deal-history fan-out (+ the wager scan) to complete on prod-sized data;
 * short enough that a pathological hang degrades to the zeroed summary
 * instead of running out the Vercel function budget.
 */
const FOUR_WEEK_LEG_TIMEOUT_MS = 60_000;

const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;
/** Backend cap per request (mirrors the creators-stats walk). */
const BACKEND_PAGE_SIZE = 100;
/** Per-creator deal-history walk cap (deal histories are a small bounded set). */
const DEAL_FETCH_CAP = 1000;

// ─── Deal-cost helpers ──────────────────────────────────────────────
// Self-contained copies of the Past Deals helpers (`past-deals.ts` /
// `deal-profitability.ts`) so this section is independently shippable. The
// money math is IDENTICAL — keep them in lockstep if the owner model changes.

/** Cost terms pulled from the creator's deal that best overlaps a frame. */
type DealTerms = {
  weeklyCapUsd: number;
  perStreamTip: number;
  perStreamSponsor: number;
  fillsAllowed: number;
};

const ZERO_TERMS: DealTerms = {
  weeklyCapUsd: 0,
  perStreamTip: 0,
  perStreamSponsor: 0,
  fillsAllowed: 0,
};

/** Coerce a backend string|number|null money field to a finite number (0 fallback). */
function toFiniteNumber(value: string | number | null | undefined): number {
  if (value == null) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Whole weeks in a frame, rounded to the nearest week and floored at 1 — used
 * to scale the per-week withdraw cap + tip/sponsor allowance over the frame.
 */
function frameWeeks(startMs: number, endMs: number): number {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return 1;
  }
  return Math.max(1, Math.round((endMs - startMs) / MS_PER_WEEK));
}

/**
 * Pick the deal whose window overlaps a frame the MOST (a bi-weekly frame can
 * overlap two weekly deals; the largest-overlap deal's terms represent the
 * frame's cadence). Returns null when no deal overlaps the frame.
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
    const overlap = Math.min(frameEndMs, de) - Math.max(frameStartMs, ds);
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
    weeklyCapUsd: toFiniteNumber(deal.total_withdraw_cap_usd),
    perStreamTip: toFiniteNumber(deal.max_tip_per_stream_usd),
    perStreamSponsor: toFiniteNumber(deal.max_sponsorship_per_stream_usd),
    fillsAllowed: Math.max(0, deal.fills_allowed ?? 0),
  };
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

export type FourWeekSummary = {
  /** Distinct `creator_user_id` across the in-window frames. */
  activeCreators: number;
  /** Σ expectedWager (dealCost / house edge) over the in-window frames. */
  expectedWagerUsd: number;
  /** Σ actual code-cohort wager inside the in-window frame windows. */
  actualWagerUsd: number;
  /** Mean configured per-deal conversion rate (bps/100) over frames WITH a deal. */
  avgConversionPct: number;
  /** Count of in-window frames folded into the totals. */
  framesCounted: number;
  /** True when the backend board walk failed (UI shows a degraded card). */
  backendUnavailable: boolean;
};

const ZERO_SUMMARY: FourWeekSummary = {
  activeCreators: 0,
  expectedWagerUsd: 0,
  actualWagerUsd: 0,
  avgConversionPct: 0,
  framesCounted: 0,
  backendUnavailable: false,
};

/**
 * The light, cacheable base: identity + cost legs + wager windows per
 * in-window frame. NO MAIN reads here — the wager scan runs per-call after
 * this returns so the cache entry stays small and reusable.
 */
type FourWeekBaseFrame = {
  /** Wager-window id (the board id — unique per frame, the wager map key). */
  boardId: string;
  /** Frame owner (drives distinct-creator count + code-cohort attribution). */
  creatorUserId: string;
  /** dealCost / house edge — the frame's expected wager to break even. */
  expectedWager: number;
  /** Configured conversion rate (bps/100), or null when the frame has no deal. */
  conversionPct: number | null;
  /** Wager window `[startMs, min(endMs, now)]` as ISO for getDealWagerByDeal. */
  startIso: string;
  endIso: string;
};

type FourWeekBase = {
  frames: FourWeekBaseFrame[];
  backendUnavailable: boolean;
};

/**
 * Cached base walk (5-min revalidate). Backend-only (approved-board walk +
 * per-owner deal history) so it resolves the prod env inside the cache scope
 * — same convention as the sibling walks in `leaderboard-cost.ts` /
 * `past-deals.ts`. `now` is computed INSIDE the fn (Past Deals does the same)
 * so the window tracks a live clock across the 5-min cache lifetime.
 */
const getFourWeekBase = unstable_cache(
  async (): Promise<FourWeekBase> => {
    let all: LeaderboardAdminRow[];
    try {
      all = await fetchAllApprovedLeaderboards();
    } catch (e) {
      console.error("[4w-summary] approved-board walk failed (empty):", e);
      return { frames: [], backendUnavailable: true };
    }

    const now = Date.now();
    const windowStart = now - MS_PER_28D;

    // In-window frames: run window OVERLAPS [now−28d, now].
    // startMs <= now && endMs >= (now−28d). Excludes purely-future
    // (start > now) and fully-past (end < now−28d).
    const inWindow = all.filter((lb) => {
      const startMs = Date.parse(lb.start_date);
      const endMs = Date.parse(lb.end_date);
      return (
        Number.isFinite(startMs) &&
        Number.isFinite(endMs) &&
        startMs <= now &&
        endMs >= windowStart
      );
    });

    if (inWindow.length === 0) {
      return { frames: [], backendUnavailable: false };
    }

    // Deal terms live per owner — fetch each frame-owner's deal history once
    // (allSettled so one failed fetch can't sink the section), then match each
    // frame to its best-overlapping deal for the cost terms + conversion rate.
    const ownerIds = Array.from(
      new Set(inWindow.map((lb) => lb.creator_user_id)),
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
          `[4w-summary] listDeals failed for creator ${ownerIds[i]} (frame costs only the LB leg):`,
          outcome.reason,
        );
        dealsByOwner.set(ownerIds[i], []);
      }
    });

    const frames: FourWeekBaseFrame[] = [];
    for (const lb of inWindow) {
      const startMs = Date.parse(lb.start_date);
      const endMs = Date.parse(lb.end_date);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;

      const dealWeeks = frameWeeks(startMs, endMs);

      // Cost terms from the owner's deal that best overlaps THIS frame.
      const deals = dealsByOwner.get(lb.creator_user_id) ?? [];
      const deal = bestOverlappingDeal(startMs, endMs, deals);
      const terms = termsFromDeal(deal);

      const weeklyCapUsd = terms.weeklyCapUsd;
      const capUsd = weeklyCapUsd * dealWeeks;
      const weeklyTipSponsorUsd =
        (terms.perStreamTip + terms.perStreamSponsor) * terms.fillsAllowed;
      const tipSponsorUsd = weeklyTipSponsorUsd * dealWeeks;

      // FULL net leaderboard prize (NOT sponsored-weighted) — owner directive
      // 2026-07-05. Floored at 0 so a fully-refunded board can't go negative.
      const leaderboardUsd = Math.max(
        0,
        (Number(lb.total_prize_usd) || 0) - (Number(lb.refund_amount_usd) || 0),
      );

      const dealCost = capUsd + leaderboardUsd + tipSponsorUsd;
      const expectedWager = dealCost / HOUSE_EDGE;

      // Conversion sample only from frames that HAVE an overlapping deal:
      // the CONFIGURED per-deal rate (bps → %), not actual/expected.
      const conversionPct =
        deal != null ? toFiniteNumber(deal.conversion_rate_bps) / 100 : null;

      frames.push({
        boardId: lb.id,
        creatorUserId: lb.creator_user_id,
        expectedWager,
        conversionPct,
        startIso: new Date(startMs).toISOString(),
        endIso: new Date(Math.min(endMs, now)).toISOString(),
      });
    }

    return { frames, backendUnavailable: false };
  },
  ["creator-hub-4week-summary-v1"],
  { revalidate: 300, tags: ["creator-hub-4w-summary"] },
);

/**
 * "4 Weeks" summary for the Creator Hub home. The cached base compute (LIGHT:
 * board walk + deal-history fan-out + cost legs) runs first; the HEAVY MAIN
 * read (`getDealWagerByDeal`) runs after and is aggregated here. Every leg is
 * guarded so a backend failure returns the zeroed summary with
 * `backendUnavailable: true` rather than throwing up the dashboard shell.
 */
export async function getFourWeekDealSummary(): Promise<FourWeekSummary> {
  const baseRes = await safeQuery(
    () => getFourWeekBase(),
    { frames: [], backendUnavailable: true },
    "creator-hub.four-week.base",
    FOUR_WEEK_LEG_TIMEOUT_MS,
  );
  const base = baseRes.data;

  if (base.backendUnavailable) {
    return { ...ZERO_SUMMARY, backendUnavailable: true };
  }

  const frames = base.frames;
  if (frames.length === 0) {
    return ZERO_SUMMARY;
  }

  // Distinct owners + Σ expectedWager + mean CONFIGURED conversion (frames
  // with a deal). These come straight off the cached base — no MAIN read.
  const activeCreators = new Set(frames.map((f) => f.creatorUserId)).size;
  const expectedWagerUsd = frames.reduce((s, f) => s + f.expectedWager, 0);
  const conversionSamples = frames
    .map((f) => f.conversionPct)
    .filter((p): p is number => p != null);
  const avgConversionPct =
    conversionSamples.length > 0
      ? conversionSamples.reduce((s, p) => s + p, 0) / conversionSamples.length
      : 0;

  // Actual wager (HEAVY MAIN read) — one batched pass over all in-window
  // frame windows, keyed by board id. Best-effort: a slow/failed scan
  // degrades this leg to 0 wager (the rest of the summary still renders).
  const wagerInputs: DealWagerWindow[] = frames.map((f) => ({
    dealId: f.boardId,
    creatorUserId: f.creatorUserId,
    startIso: f.startIso,
    endIso: f.endIso,
  }));
  const wagerRes = await safeQuery(
    () => getDealWagerByDeal(wagerInputs),
    new Map<string, number>(),
    "creator-hub.four-week.wager",
    FOUR_WEEK_LEG_TIMEOUT_MS,
  );
  const wagerMap = wagerRes.data;
  const actualWagerUsd = frames.reduce(
    (s, f) => s + (wagerMap.get(f.boardId) ?? 0),
    0,
  );

  return {
    activeCreators,
    expectedWagerUsd,
    actualWagerUsd,
    avgConversionPct,
    framesCounted: frames.length,
    backendUnavailable: false,
  };
}
