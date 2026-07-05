import "server-only";

import { unstable_cache } from "next/cache";

import { creatorsApi, type CreatorDealResponse } from "@/lib/backend-api";
import {
  affiliateLeaderboardsApi,
  type LeaderboardAdminRow,
} from "@/lib/backend-api/affiliate-leaderboards";
import { safeQuery } from "@/lib/errors/safe-query";
import { getDb } from "@/lib/db";

import {
  getDealWagerByDeal,
  type DealWagerWindow,
} from "../profitability/_queries/frame-wager-by-deal";
import { getLeaderboardSponsorshipMap } from "../../../(admin)/creators/_queries/leaderboard-sponsorship";

/**
 * Creator Hub — "4 Weeks" summary.
 *
 * A FIXED rolling 28-day window `[now − 28d, now]`. Frame-centric (the owner's
 * model: "a leaderboard frame IS the deal"): every APPROVED affiliate
 * leaderboard that ENDED within the 28-day window contributes — anything with
 * `end_date ∈ [now − 28d, now)`. Still-live frames (end ≥ now) belong to the
 * Active tab and are excluded; fully-past frames (end < now−28d) too. Ended-
 * only + sponsored-weighted LB (below) = the SAME model as the Past Deals tab,
 * so this section reconciles with it (owner request 2026-07-05).
 *
 * Per-frame cost (NO daily-fill leg; sponsored-weighted LB — matches Past Deals):
 *
 *   dealWeeks        = frameWeeks(startMs, endMs)                       (≥ 1)
 *   weeklyCapUsd     = toFiniteNumber(deal.total_withdraw_cap_usd)      (0 uncapped)
 *   capUsd           = weeklyCapUsd × dealWeeks
 *   weeklyTipSponsor = (tip + sponsor) × max(0, fills_allowed)
 *   tipSponsorUsd    = weeklyTipSponsor × dealWeeks
 *   leaderboardUsd   = max(0, net prize − refund) × sponsored% / 100   (house-paid share)
 *   dealCost         = capUsd + leaderboardUsd + tipSponsorUsd          (NO fill leg)
 *   expectedWager    = dealCost / 0.075                                 (house edge)
 *
 * A frame with NO overlapping deal contributes only its leaderboardUsd leg
 * (cap / tip = 0) and NO conversion sample.
 *
 * The FOUR tile values:
 *   • activeCreators   = distinct `creator_user_id` across in-window frames.
 *   • expectedWagerUsd = Σ expectedWager over in-window frames.
 *   • actualWagerUsd   = Σ getDealWagerByDeal over in-window frames.
 *   • avgConversionPct = mean over frames WITH an overlapping deal of
 *                        `deal.conversion_rate_bps / 100` (configured rate,
 *                        NOT actual/expected).
 *
 * RESILIENCE (hardened after the 2026-07-05 incident, digest 491822067):
 *   • The base compute owns its OWN uncached approved-board walk (mirrors
 *     `past-deals.ts`) — it does NOT call the cached `fetchAllApprovedLeaderboards`,
 *     so there is no `unstable_cache`-inside-`unstable_cache` nesting.
 *   • Both heavy legs are `safeQuery`-bounded at timeouts (25s + 20s) well
 *     under the page's `maxDuration = 120`, so a slow cold scan ALWAYS
 *     degrades to the zeroed / "unavailable" card instead of racing the
 *     platform's function kill (which would 500 the whole hub).
 *   • The query itself never throws; the page ALSO wraps the section in a
 *     `SectionErrorBoundary` so even an unexpected render throw can't take
 *     the dashboard down.
 * `now` is computed INSIDE the cached fn (same as Past Deals). Money is
 * Decimal-safe throughout (backend strings coerced via `Number` / helper).
 */

const HOUSE_EDGE = 0.075;
const MS_PER_28D = 28 * 24 * 60 * 60 * 1000;
const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

/** Backend cap per request (mirrors the creators-stats / past-deals walks). */
const BACKEND_PAGE_SIZE = 100;
/** Per-creator deal-history walk cap (deal histories are a small bounded set). */
const DEAL_FETCH_CAP = 1000;
/** Cold-walk safety cap for the approved-board walk (mirrors past-deals). */
const BOARD_FETCH_CAP = 2000;

/**
 * Per-leg timeouts. Deliberately WELL UNDER the page's `maxDuration = 120`
 * (25 + 20 = 45s worst case) so a slow cold scan degrades to the fallback
 * card rather than running the serverless function out to its hard kill —
 * which surfaced as the whole-hub 500 (digest 491822067). The underlying DB
 * statement is not cancelled; the next cache fill picks up the warm result.
 */
const BASE_TIMEOUT_MS = 25_000;
const WAGER_TIMEOUT_MS = 20_000;
/** Username resolution for the tile drill-down — bounded PK lookup, best-effort. */
const USERNAME_TIMEOUT_MS = 10_000;

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

/**
 * Own uncached walk of every APPROVED leaderboard (first-page-then-parallel).
 * Mirrors `walkAllApprovedLeaderboards` in `past-deals.ts` — deliberately NOT
 * the cached `fetchAllApprovedLeaderboards` export, so the cached base below
 * never nests `unstable_cache` inside `unstable_cache`.
 */
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

/**
 * Per-creator breakdown row — the "where it's coming from" drill-down behind
 * each headline tile. One row per creator with an in-window deal frame; each
 * metric summed / averaged across THAT creator's frames.
 */
export type FourWeekCreatorRow = {
  userId: string;
  /** Resolved username (MAIN read), or null when unresolved. */
  username: string | null;
  /** Σ expectedWager across this creator's in-window frames. */
  expectedWagerUsd: number;
  /** Σ actual code-cohort wager across this creator's in-window frames. */
  actualWagerUsd: number;
  /** Mean configured conversion rate (bps/100) across this creator's frames with a deal. */
  avgConversionPct: number;
  /** Number of in-window deal frames this creator has. */
  frameCount: number;
};

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
  /** Per-creator contributions (the tile drill-down), sorted by expected wager desc. */
  breakdown: FourWeekCreatorRow[];
  /** True when the backend board walk failed (UI shows a degraded card). */
  backendUnavailable: boolean;
};

const ZERO_SUMMARY: FourWeekSummary = {
  activeCreators: 0,
  expectedWagerUsd: 0,
  actualWagerUsd: 0,
  avgConversionPct: 0,
  framesCounted: 0,
  breakdown: [],
  backendUnavailable: false,
};

/** The light, cacheable base: identity + cost legs + wager windows per frame. */
type FourWeekBaseFrame = {
  boardId: string;
  creatorUserId: string;
  expectedWager: number;
  conversionPct: number | null;
  startIso: string;
  endIso: string;
};

type FourWeekBase = {
  frames: FourWeekBaseFrame[];
  backendUnavailable: boolean;
};

/**
 * Cached base walk (5-min revalidate). Backend-only (approved-board walk +
 * per-owner deal history) so it resolves the prod env inside the cache scope.
 * `now` is computed INSIDE the fn (Past Deals does the same). Uses its OWN
 * uncached board walk — no nested `unstable_cache`.
 */
const getFourWeekBase = unstable_cache(
  async (): Promise<FourWeekBase> => {
    let all: LeaderboardAdminRow[];
    try {
      all = await walkAllApprovedLeaderboards();
    } catch (e) {
      console.error("[4w-summary] approved-board walk failed (empty):", e);
      return { frames: [], backendUnavailable: true };
    }

    const now = Date.now();
    const windowStart = now - MS_PER_28D;

    // Frames that ENDED within the last 28 days (end_date ∈ [now−28d, now)).
    // Ended-only + sponsored-weighted LB (below) = the SAME model as the Past
    // Deals tab, so this section reconciles with it. A still-live frame
    // (end ≥ now) is excluded — it belongs to the Active tab.
    const inWindow = all.filter((lb) => {
      const endMs = Date.parse(lb.end_date);
      return Number.isFinite(endMs) && endMs < now && endMs >= windowStart;
    });

    if (inWindow.length === 0) {
      return { frames: [], backendUnavailable: false };
    }

    // Sponsored % per frame (the LB leg's house-share weighting) — resilient:
    // a lookup blip treats every board as 100% (full net), same as Past Deals.
    let sponsorship: Map<string, number>;
    try {
      sponsorship = await getLeaderboardSponsorshipMap(
        inWindow.map((lb) => lb.id),
      );
    } catch (e) {
      console.error(
        "[4w-summary] sponsorship lookup failed (treating all as 100%):",
        e,
      );
      sponsorship = new Map();
    }

    // Deal terms live per owner — fetch each frame-owner's deal history once
    // (allSettled so one failed fetch can't sink the section).
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
      const deals = dealsByOwner.get(lb.creator_user_id) ?? [];
      const deal = bestOverlappingDeal(startMs, endMs, deals);
      const terms = termsFromDeal(deal);

      const capUsd = terms.weeklyCapUsd * dealWeeks;
      const weeklyTipSponsorUsd =
        (terms.perStreamTip + terms.perStreamSponsor) * terms.fillsAllowed;
      const tipSponsorUsd = weeklyTipSponsorUsd * dealWeeks;

      // Sponsored-WEIGHTED leaderboard house cost (net prize × sponsored% / 100)
      // — the "house actually pays" figure, matching the Past Deals tab so the
      // two reconcile. Missing annotation → 100% (full net). Floored at 0.
      const net = Math.max(
        0,
        (Number(lb.total_prize_usd) || 0) - (Number(lb.refund_amount_usd) || 0),
      );
      const pct = Math.min(100, Math.max(0, sponsorship.get(lb.id) ?? 100));
      const leaderboardUsd = net * (pct / 100);

      const dealCost = capUsd + leaderboardUsd + tipSponsorUsd;
      const expectedWager = dealCost / HOUSE_EDGE;
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
  // v3: ended-frames-only + sponsored-weighted LB so the tile reconciles with
  // the Past Deals tab (was v2: own uncached walk + tight timeouts after
  // incident 491822067). Fresh key so a prior cache entry can't shadow.
  ["creator-hub-4week-summary-v3"],
  { revalidate: 300, tags: ["creator-hub-4w-summary"] },
);

/**
 * "4 Weeks" summary for the Creator Hub home. Both heavy legs are
 * `safeQuery`-bounded well under the page's `maxDuration`, and every failure
 * path returns the zeroed summary rather than throwing.
 */
export async function getFourWeekDealSummary(): Promise<FourWeekSummary> {
  const baseRes = await safeQuery(
    () => getFourWeekBase(),
    { frames: [], backendUnavailable: true } as FourWeekBase,
    "creator-hub.four-week.base",
    BASE_TIMEOUT_MS,
  );
  const base = baseRes.data;

  if (base.backendUnavailable) {
    return { ...ZERO_SUMMARY, backendUnavailable: true };
  }

  const frames = base.frames;
  if (frames.length === 0) {
    return ZERO_SUMMARY;
  }

  const activeCreators = new Set(frames.map((f) => f.creatorUserId)).size;
  const expectedWagerUsd = frames.reduce((s, f) => s + f.expectedWager, 0);
  const conversionSamples = frames
    .map((f) => f.conversionPct)
    .filter((p): p is number => p != null);
  const avgConversionPct =
    conversionSamples.length > 0
      ? conversionSamples.reduce((s, p) => s + p, 0) / conversionSamples.length
      : 0;

  // Actual wager (HEAVY MAIN read) — one batched pass over all in-window frame
  // windows, keyed by board id. Best-effort: a slow/failed scan degrades this
  // leg to 0 wager (the rest of the summary still renders).
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
    WAGER_TIMEOUT_MS,
  );
  const wagerMap = wagerRes.data;
  const actualWagerUsd = frames.reduce(
    (s, f) => s + (wagerMap.get(f.boardId) ?? 0),
    0,
  );

  // Per-creator breakdown (the tile drill-down). Aggregate each creator's
  // frames, then resolve usernames in one bounded MAIN read (best-effort — a
  // failure just leaves usernames null and the UI falls back to a short id).
  type Agg = {
    expectedWagerUsd: number;
    actualWagerUsd: number;
    convSum: number;
    convCount: number;
    frameCount: number;
  };
  const perCreator = new Map<string, Agg>();
  for (const f of frames) {
    const cur =
      perCreator.get(f.creatorUserId) ?? {
        expectedWagerUsd: 0,
        actualWagerUsd: 0,
        convSum: 0,
        convCount: 0,
        frameCount: 0,
      };
    cur.expectedWagerUsd += f.expectedWager;
    cur.actualWagerUsd += wagerMap.get(f.boardId) ?? 0;
    if (f.conversionPct != null) {
      cur.convSum += f.conversionPct;
      cur.convCount += 1;
    }
    cur.frameCount += 1;
    perCreator.set(f.creatorUserId, cur);
  }

  const creatorIds = [...perCreator.keys()];
  const nameRes = await safeQuery(
    async () => {
      const db = await getDb();
      const users = await db.user.findMany({
        where: { id: { in: creatorIds } },
        select: { id: true, username: true },
      });
      return new Map<string, string | null>(
        users.map((u) => [u.id, u.username ?? null]),
      );
    },
    new Map<string, string | null>(),
    "creator-hub.four-week.usernames",
    USERNAME_TIMEOUT_MS,
  );
  const nameMap = nameRes.data;

  const breakdown: FourWeekCreatorRow[] = [...perCreator.entries()]
    .map(([userId, a]) => ({
      userId,
      username: nameMap.get(userId) ?? null,
      expectedWagerUsd: a.expectedWagerUsd,
      actualWagerUsd: a.actualWagerUsd,
      avgConversionPct: a.convCount > 0 ? a.convSum / a.convCount : 0,
      frameCount: a.frameCount,
    }))
    .sort((x, y) => y.expectedWagerUsd - x.expectedWagerUsd);

  return {
    activeCreators,
    expectedWagerUsd,
    actualWagerUsd,
    avgConversionPct,
    framesCounted: frames.length,
    breakdown,
    backendUnavailable: false,
  };
}
