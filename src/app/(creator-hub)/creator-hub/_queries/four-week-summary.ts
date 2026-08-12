import "server-only";

import { unstable_cache } from "next/cache";

import { creatorsApi, type CreatorDealResponse } from "@/lib/backend-api";
import {
  affiliateLeaderboardsApi,
  type LeaderboardAdminRow,
} from "@/lib/backend-api/affiliate-leaderboards";
import { safeQuery } from "@/lib/errors/safe-query";
import { inArray } from "drizzle-orm";
import { getReadDrizzleDb } from "@/lib/db";
import { user } from "@/lib/db-schema/main/schema";
import { computeDealCost, weeklyDealsInFrame } from "@/lib/deal-economics";
import { getLeaderboardSponsorshipMap } from "../../../(admin)/creators/_queries/leaderboard-sponsorship";

import { mapPool, pagedWalk } from "../_lib/backend-walk";
import {
  getDealWagerByDeal,
  type DealWagerWindow,
} from "../profitability/_queries/frame-wager-by-deal";

/**
 * Creator Hub — "4 Weeks" summary.
 *
 * A FIXED rolling 28-day window `[now − 28d, now]`. Frame-centric (the owner's
 * model: "a leaderboard frame IS the deal"): every APPROVED affiliate
 * leaderboard that ENDED within the 28-day window contributes — anything with
 * `end_date ∈ [now − 28d, now)`. Still-live frames (end ≥ now) belong to the
 * Active tab and are excluded; fully-past frames (end < now−28d) too. Ended-
 * only + the canonical `computeDealCost` (below) = the SAME model as the Past
 * Deals tab, so this section reconciles with it (owner request 2026-07-05).
 *
 * Per-frame cost — the canonical `@/lib/deal-economics` model:
 *
 *   wds              = weeklyDealsInFrame(startMs, endMs, deals)   (any overlap)
 *   dealCost         = Σ over wds of ( full withdraw cap
 *                        + (tip + sponsor) × fills_allowed )
 *                      + leaderboard net prize × stored house share
 *   expectedWager    = dealCost / 0.075                            (house edge)
 *
 * A frame with NO overlapping weekly deal contributes only its leaderboard
 * leg (cap / tip = 0) and NO conversion sample.
 *
 * The FOUR tile values:
 *   • activeCreators     = distinct `creator_user_id` across in-window frames.
 *   • expectedWagerUsd   = Σ expectedWager over in-window frames.
 *   • actualWagerUsd     = Σ getDealWagerByDeal over in-window frames.
 *   • avgConversionRatio = mean over creators (expected > 0) of
 *                          actualWager ÷ expectedWager — the same "Conversion"
 *                          as the Profitability tab (NOT the configured rate).
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

const MS_PER_28D = 28 * 24 * 60 * 60 * 1000;

/** Backend cap per request (mirrors the creators-stats / past-deals walks). */
const BACKEND_PAGE_SIZE = 100;
/** Per-creator deal-history walk cap (deal histories are a small bounded set). */
const DEAL_FETCH_CAP = 1000;
/** Cold-walk safety cap for the approved-board walk (mirrors past-deals). */
const BOARD_FETCH_CAP = 2000;
/**
 * Bounded concurrency for the per-owner deal-history fan-out (mirrors the
 * tips/sponsors fan-out) — a large frame set must not stampede the backend
 * admin API with one multi-page walk per owner all at once.
 */
const DEAL_FETCH_CONCURRENCY = 6;

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
// All cost math now routes through the canonical `@/lib/deal-economics`
// helpers (`weeklyDealsInFrame` + `computeDealCost`) so this section
// reconciles with Past Deals + Active by construction.

/** Fetch one creator's FULL deal history, paging the backend. */
async function fetchAllDealsForCreator(
  userId: string,
): Promise<CreatorDealResponse[]> {
  return pagedWalk(
    (offset, limit) =>
      creatorsApi
        .listDeals(userId, { offset, limit })
        .then((page) => ({ rows: page.data, total: page.total })),
    DEAL_FETCH_CAP,
    BACKEND_PAGE_SIZE,
  );
}

/**
 * Own uncached walk of every APPROVED leaderboard (first-page-then-parallel).
 * Mirrors `walkAllApprovedLeaderboards` in `past-deals.ts` — deliberately NOT
 * the cached `fetchAllApprovedLeaderboards` export, so the cached base below
 * never nests `unstable_cache` inside `unstable_cache`.
 */
async function walkAllApprovedLeaderboards(): Promise<LeaderboardAdminRow[]> {
  return pagedWalk(
    (offset, limit) =>
      affiliateLeaderboardsApi
        .list({ status: "approved", offset, limit })
        .then((page) => ({ rows: page.leaderboards, total: page.total })),
    BOARD_FETCH_CAP,
    BACKEND_PAGE_SIZE,
  );
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
  /** Conversion = actualWagerUsd ÷ expectedWagerUsd (0 when no expected wager). */
  conversionRatio: number;
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
  /** Mean conversion (actualWager ÷ expectedWager) over creators with expected wager > 0. */
  avgConversionRatio: number;
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
  avgConversionRatio: 0,
  framesCounted: 0,
  breakdown: [],
  backendUnavailable: false,
};

/** The light, cacheable base: identity + cost legs + wager windows per frame. */
type FourWeekBaseFrame = {
  boardId: string;
  creatorUserId: string;
  expectedWager: number;
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

    // Deal terms live per owner — fetch each frame-owner's deal history once,
    // with bounded concurrency (mapPool) so a large frame set can't stampede
    // the backend admin API; a failed fetch degrades that owner to [] instead
    // of sinking the section.
    const ownerIds = Array.from(
      new Set(inWindow.map((lb) => lb.creator_user_id)),
    );
    const sponsorship = await getLeaderboardSponsorshipMap(
      inWindow.map((lb) => lb.id),
    );
    const dealsByOwner = new Map<string, CreatorDealResponse[]>();
    await mapPool(ownerIds, DEAL_FETCH_CONCURRENCY, async (id) => {
      try {
        dealsByOwner.set(id, await fetchAllDealsForCreator(id));
      } catch (err) {
        console.error(
          `[4w-summary] listDeals failed for creator ${id} (frame costs only the LB leg):`,
          err,
        );
        dealsByOwner.set(id, []);
      }
    });

    const frames: FourWeekBaseFrame[] = [];
    for (const lb of inWindow) {
      const startMs = Date.parse(lb.start_date);
      const endMs = Date.parse(lb.end_date);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;

      // Canonical deal cost — the weekly fill-deals overlapping this frame,
      // each at FULL cap + (tip + sponsor) × fills, plus the leaderboard net
      // prize × 50%. expectedWager = dealCost / 7.5%.
      const deals = dealsByOwner.get(lb.creator_user_id) ?? [];
      const wds = weeklyDealsInFrame(startMs, endMs, deals);
      const { expectedWager } = computeDealCost({
        weeklyDeals: wds,
        lbPrizeUsd: lb.total_prize_usd,
        lbRefundUsd: lb.refund_amount_usd,
        lbHouseSharePct: sponsorship.get(lb.id) ?? 100,
      });

      frames.push({
        boardId: lb.id,
        creatorUserId: lb.creator_user_id,
        expectedWager,
        startIso: new Date(startMs).toISOString(),
        endIso: new Date(Math.min(endMs, now)).toISOString(),
      });
    }

    return { frames, backendUnavailable: false };
  },
  // v5: cost now routes through the canonical `computeDealCost`
  // (Σ full cap + (tip+sponsor)×fills over the frame's weekly deals + LB net
  // × 50%) instead of the old best-overlap × frameWeeks + sponsored-% LB.
  // (v4 = actualWager/expectedWager conversion; v3 = ended-only + sponsored-
  // weighted LB; v2 = the own-uncached-walk + tight-timeout incident fix.)
  // Fresh key so a prior cache entry can't shadow the new shape.
  ["creator-hub-4week-summary-v5"],
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
    frameCount: number;
  };
  const perCreator = new Map<string, Agg>();
  for (const f of frames) {
    const cur =
      perCreator.get(f.creatorUserId) ?? {
        expectedWagerUsd: 0,
        actualWagerUsd: 0,
        frameCount: 0,
      };
    cur.expectedWagerUsd += f.expectedWager;
    cur.actualWagerUsd += wagerMap.get(f.boardId) ?? 0;
    cur.frameCount += 1;
    perCreator.set(f.creatorUserId, cur);
  }

  const creatorIds = [...perCreator.keys()];
  const nameRes = await safeQuery(
    async () => {
      const db = await getReadDrizzleDb();
      const users = await db
        .select({ id: user.id, username: user.username })
        .from(user)
        .where(inArray(user.id, creatorIds));
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
      conversionRatio:
        a.expectedWagerUsd > 0 ? a.actualWagerUsd / a.expectedWagerUsd : 0,
      frameCount: a.frameCount,
    }))
    .sort((x, y) => y.expectedWagerUsd - x.expectedWagerUsd);

  // Headline conversion = mean over creators with expected wager > 0 of their
  // actual÷expected ratio (same "Conversion" metric as the Profitability tab),
  // so it equals a plain average of the visible breakdown rows.
  const converting = breakdown.filter((r) => r.expectedWagerUsd > 0);
  const avgConversionRatio =
    converting.length > 0
      ? converting.reduce((s, r) => s + r.conversionRatio, 0) / converting.length
      : 0;

  return {
    activeCreators,
    expectedWagerUsd,
    actualWagerUsd,
    avgConversionRatio,
    framesCounted: frames.length,
    breakdown,
    backendUnavailable: false,
  };
}
