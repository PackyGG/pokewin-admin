import "server-only";

import { unstable_cache } from "next/cache";

import {
  affiliateLeaderboardsApi,
  type LeaderboardAdminRow,
} from "@/lib/backend-api/affiliate-leaderboards";
import { getDb } from "@/lib/db";
// Reuse the EXISTING admin-side sponsored-% lookup (the house's prize-pool
// share). The (creator-hub) group is a sibling of (admin) on disk, so this
// relative path crosses the route-group boundary to the canonical query
// module that /creators/leaderboards + leaderboard-cost.ts already use.
import { getLeaderboardSponsorshipMap } from "../../../../(admin)/creators/_queries/leaderboard-sponsorship";
import {
  getCreatorLeaderboardWagerMap,
  type LeaderboardWagerInput,
} from "../../../../(admin)/creators/[userId]/_queries/leaderboard-wager-by-board";

/**
 * Live Leaderboards ranklist — data layer.
 *
 * A ranked list of every CURRENTLY-RUNNING (and, for context, soon-to-start)
 * creator affiliate leaderboard, live across all creators. Built ENTIRELY on
 * the existing data layer — no new MAIN schema, no duplicated cost logic:
 *
 *   • Boards            → `affiliateLeaderboardsApi.list({ status: "approved" })`
 *                          (the same approved-board walk leaderboard-cost.ts uses;
 *                          a rejected board never runs, a pending one isn't a
 *                          committed spend yet).
 *   • House share %     → `getLeaderboardSponsorshipMap` (admin DB), defaulting
 *                          to 100% when un-annotated — identical convention +
 *                          weighting to `leaderboard-cost.ts`.
 *   • Creator usernames → `db.user.findMany` (MAIN, READ-ONLY) — same hydration
 *                          the /creators/leaderboards table does.
 *
 * House cost per board = (total_prize_usd − refund) × house% — the rose
 * house-cost figure. The creator funds the off-site remainder.
 *
 * ACTIVE vs UPCOMING: partitioned by each board's run window relative to NOW,
 * using the SAME date math as `getLeaderboardCostTotal` (ended → end_date < now;
 * active → now ∈ [start, end]; upcoming → start in the future). We also trust
 * the backend's own `time_status` as a cross-check but bucket on the parsed
 * dates so the figures reconcile to the cost tile by construction.
 *
 * READ-ONLY + cached: the backend walk + sponsorship lookup are wrapped in
 * `unstable_cache` (60s) so repeated views / a period repaint don't re-walk the
 * backend. No MAIN writes anywhere.
 */

// The backend caps `limit` per request at 100; mirror the page size the
// creators-stats + leaderboard-cost walks use. FETCH_CAP guards a runaway
// loop — creator leaderboards are a small bounded set; 500 is well above any
// realistic concurrent count.
const BACKEND_PAGE_SIZE = 100;
const FETCH_CAP = 500;

/** Run-window bucket for a board, relative to NOW. */
export type BoardLifecycle = "active" | "upcoming" | "ended";

/** Which lifecycle slice the ranklist shows. */
export type LiveLeaderboardView = "active" | "upcoming" | "ended" | "all";

export const LIVE_LB_VIEWS: readonly LiveLeaderboardView[] = [
  "active",
  "upcoming",
  "ended",
  "all",
] as const;

export function parseLiveLeaderboardView(
  raw: string | undefined,
): LiveLeaderboardView {
  return (LIVE_LB_VIEWS as readonly string[]).includes(raw ?? "")
    ? (raw as LiveLeaderboardView)
    : "active";
}

/** How to rank the visible ranklist. */
export type LiveLeaderboardRank =
  | "house_cost"
  | "house_cost_asc"
  | "prize_pool"
  | "prize_pool_asc"
  | "wager"
  | "wager_asc"
  | "ending_soon"
  | "starting_soon"
  | "recently_ended";

export const LIVE_LB_RANKS: readonly LiveLeaderboardRank[] = [
  "house_cost",
  "house_cost_asc",
  "prize_pool",
  "prize_pool_asc",
  "wager",
  "wager_asc",
  "ending_soon",
  "starting_soon",
  "recently_ended",
] as const;

export function parseLiveLeaderboardRank(
  raw: string | undefined,
): LiveLeaderboardRank {
  return (LIVE_LB_RANKS as readonly string[]).includes(raw ?? "")
    ? (raw as LiveLeaderboardRank)
    : "house_cost";
}

/** One ranked live-leaderboard row — fully serializable (no Decimals/Dates). */
export type LiveLeaderboardRow = {
  /** Backend leaderboard id. */
  id: string;
  /** Board title (its display name on /creators/leaderboards). */
  title: string;
  /** Affiliate codes that feed the board. */
  affiliateCodes: string[];
  /** Primary owner's user id — the creator who funds the board. */
  creatorUserId: string;
  /** Co-creators whose codes also count toward this board. */
  coCreatorUserIds: string[];
  /** Resolved owner username (MAIN read), or null when unresolved. */
  creatorUsername: string | null;
  /** Total wager in the board window (affiliate_code_usages, same as detail). */
  wagerUsd: number;
  /** Full prize pool, net of refunds (100%, no weighting). */
  prizeUsd: number;
  /** Admin-set house share % (0–100); 100 when un-annotated. */
  housePct: number;
  /** House's share of the pool: prizeUsd × housePct / 100 (rose). */
  houseCostUsd: number;
  /** ISO start date (for display + a client time ticker). */
  startIso: string;
  /** ISO end date (for display + a client time ticker). */
  endIso: string;
  /** Run-window bucket relative to the snapshot clock. */
  lifecycle: BoardLifecycle;
  /**
   * Milliseconds until the board ends (active) or starts (upcoming),
   * computed once at request time. Negative/0 → already elapsed. The client
   * ticker re-syncs to the live clock on mount, so this is just the SSR seed.
   */
  msUntilEdge: number;
};

/** Headline figures + ranked rows for the requested view. */
export type LiveLeaderboardsResult = {
  /** Boards for the current view, ranked per `rank`. */
  rows: LiveLeaderboardRow[];
  view: LiveLeaderboardView;
  rank: LiveLeaderboardRank;
  activeCount: number;
  upcomingCount: number;
  endedCount: number;
  /** Σ net prize pool across rows in the current view. */
  viewPrizeUsd: number;
  /** Σ house cost across rows in the current view (rose). */
  viewHouseCostUsd: number;
  /** Prize-weighted house share across the current view. */
  viewHouseSharePct: number;
  /** Σ wager across rows in the current view. */
  viewWagerUsd: number;
  /** True when the backend leaderboard walk failed (UI shows an error state). */
  backendUnavailable: boolean;
  /** Request-time snapshot clock (ms epoch) the buckets/edges were computed against. */
  snapshotMs: number;
};

/**
 * Walk every APPROVED affiliate leaderboard, first-page-then-parallel, up to
 * FETCH_CAP rows. Mirrors the leaderboard-cost.ts walk (kept local rather than
 * exported from there to avoid editing that shared cost module).
 */
/** Paginated approved-board walk (backend caps `limit` at 100 per page). */
export async function fetchAllApprovedLeaderboards(): Promise<LeaderboardAdminRow[]> {
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
 * Build the raw (un-ranked, username-less) live + upcoming partition from the
 * approved-board walk + sponsorship map. Cached for 60s on the approved set so
 * repeated Hub views don't re-walk the backend. Username hydration happens
 * OUTSIDE the cache (MAIN read), then ranking is applied per request.
 */
const getLiveLeaderboardsBase = unstable_cache(
  async (): Promise<{
    rows: LiveLeaderboardBaseRow[];
    backendUnavailable: boolean;
    snapshotMs: number;
  }> => {
    const snapshotMs = Date.now();
    let all: LeaderboardAdminRow[];
    try {
      all = await fetchAllApprovedLeaderboards();
    } catch (e) {
      console.error(
        "[live-leaderboards] approved-board walk failed (ranklist empty):",
        e,
      );
      return { rows: [], backendUnavailable: true, snapshotMs };
    }

    // Sponsored % per board (house share). Resilient: a blip → treat every
    // board as 100% (house cost collapses to the un-weighted pool) rather than
    // blanking the whole list. Same fallback as leaderboard-cost.ts.
    let sponsorship: Map<string, number>;
    try {
      sponsorship = await getLeaderboardSponsorshipMap(all.map((lb) => lb.id));
    } catch (e) {
      console.error(
        "[live-leaderboards] sponsorship lookup failed (treating all as 100%):",
        e,
      );
      sponsorship = new Map();
    }

    const rows: Omit<LiveLeaderboardRow, "creatorUsername" | "wagerUsd">[] = [];
    for (const lb of all) {
      const prize = Number(lb.total_prize_usd) || 0;
      const refund = Number(lb.refund_amount_usd) || 0;
      const net = prize - refund;
      // No annotation → 100%. Clamp defensively to the 0–100 range.
      const pct = Math.min(100, Math.max(0, sponsorship.get(lb.id) ?? 100));
      const houseCost = net * (pct / 100);

      // Bucket by run window relative to the snapshot clock — same date math
      // as getLeaderboardCostTotal. ENDED = end strictly past; ACTIVE = now
      // within [start, end]; otherwise UPCOMING. Unparseable dates fall
      // through to "ended" (treated as not-live) rather than poisoning a total.
      const start = new Date(lb.start_date).getTime();
      const end = new Date(lb.end_date).getTime();
      let lifecycle: BoardLifecycle;
      let msUntilEdge: number;
      if (Number.isFinite(start) && start > snapshotMs) {
        lifecycle = "upcoming";
        msUntilEdge = start - snapshotMs;
      } else if (
        Number.isFinite(start) &&
        Number.isFinite(end) &&
        start <= snapshotMs &&
        end >= snapshotMs
      ) {
        lifecycle = "active";
        msUntilEdge = end - snapshotMs;
      } else {
        lifecycle = "ended";
        msUntilEdge = Number.isFinite(end) ? end - snapshotMs : 0;
      }

      rows.push({
        id: lb.id,
        title: lb.title,
        affiliateCodes: lb.affiliate_codes ?? [],
        creatorUserId: lb.creator_user_id,
        coCreatorUserIds: lb.co_creator_user_ids ?? [],
        prizeUsd: net,
        housePct: pct,
        houseCostUsd: houseCost,
        startIso: lb.start_date,
        endIso: lb.end_date,
        lifecycle,
        msUntilEdge,
      });
    }
    return { rows, backendUnavailable: false, snapshotMs };
  },
  ["creator-hub:live-leaderboards:base:v2"],
  { revalidate: 60, tags: ["creator-hub-live-leaderboards"] },
);

type LiveLeaderboardBaseRow = Omit<
  LiveLeaderboardRow,
  "creatorUsername" | "wagerUsd"
>;

function filterByView(
  rows: LiveLeaderboardBaseRow[],
  view: LiveLeaderboardView,
): LiveLeaderboardBaseRow[] {
  if (view === "all") return rows;
  return rows.filter((r) => r.lifecycle === view);
}

/** Apply the requested ranking (copy, never mutate). */
function rankRows(
  rows: LiveLeaderboardRow[],
  rank: LiveLeaderboardRank,
  view: LiveLeaderboardView,
): LiveLeaderboardRow[] {
  const sorted = [...rows];
  switch (rank) {
    case "prize_pool_asc":
      sorted.sort((a, b) => a.prizeUsd - b.prizeUsd);
      break;
    case "prize_pool":
      sorted.sort((a, b) => b.prizeUsd - a.prizeUsd);
      break;
    case "house_cost_asc":
      sorted.sort((a, b) => a.houseCostUsd - b.houseCostUsd);
      break;
    case "wager":
      sorted.sort((a, b) => b.wagerUsd - a.wagerUsd);
      break;
    case "wager_asc":
      sorted.sort((a, b) => a.wagerUsd - b.wagerUsd);
      break;
    case "starting_soon":
      sorted.sort((a, b) => a.msUntilEdge - b.msUntilEdge);
      break;
    case "recently_ended":
      sorted.sort((a, b) => b.msUntilEdge - a.msUntilEdge);
      break;
    case "ending_soon":
      if (view === "upcoming" || view === "all") {
        sorted.sort((a, b) => {
          if (a.lifecycle === "upcoming" && b.lifecycle !== "upcoming") return -1;
          if (b.lifecycle === "upcoming" && a.lifecycle !== "upcoming") return 1;
          if (a.lifecycle === "active" && b.lifecycle !== "active") return -1;
          if (b.lifecycle === "active" && a.lifecycle !== "active") return 1;
          const av =
            a.msUntilEdge <= 0 ? Number.POSITIVE_INFINITY : a.msUntilEdge;
          const bv =
            b.msUntilEdge <= 0 ? Number.POSITIVE_INFINITY : b.msUntilEdge;
          return av - bv;
        });
      } else {
        sorted.sort((a, b) => {
          const av =
            a.msUntilEdge <= 0 ? Number.POSITIVE_INFINITY : a.msUntilEdge;
          const bv =
            b.msUntilEdge <= 0 ? Number.POSITIVE_INFINITY : b.msUntilEdge;
          return av - bv;
        });
      }
      break;
    case "house_cost":
    default:
      sorted.sort((a, b) => b.houseCostUsd - a.houseCostUsd);
      break;
  }
  return sorted;
}

async function attachWagerTotals(
  rows: LiveLeaderboardBaseRow[],
): Promise<Map<string, number>> {
  if (rows.length === 0) return new Map();
  const inputs: LeaderboardWagerInput[] = rows.map((r) => ({
    id: r.id,
    creatorUserId: r.creatorUserId,
    coCreatorUserIds: r.coCreatorUserIds,
    affiliateCodes: r.affiliateCodes,
    startDate: new Date(r.startIso),
    endDate: new Date(r.endIso),
  }));
  try {
    return await getCreatorLeaderboardWagerMap(inputs);
  } catch (e) {
    console.error("[live-leaderboards] wager map failed (showing 0):", e);
    return new Map();
  }
}

/**
 * Live Leaderboards ranklist for the Creator Hub. Returns the ACTIVE boards
 * ranked per `rank` (default: priciest house cost first) plus the UPCOMING
 * boards (soonest-first) and the headline active totals.
 *
 * Active-timeframe-only: one read, served from the 60s cache; no eager
 * preloading of other views. READ-ONLY across MAIN (usernames) + the backend.
 */
export async function getLiveLeaderboards(
  rank: LiveLeaderboardRank = "house_cost",
  view: LiveLeaderboardView = "active",
): Promise<LiveLeaderboardsResult> {
  const base = await getLiveLeaderboardsBase();

  const activeCount = base.rows.filter((r) => r.lifecycle === "active").length;
  const upcomingCount = base.rows.filter((r) => r.lifecycle === "upcoming").length;
  const endedCount = base.rows.filter((r) => r.lifecycle === "ended").length;

  const viewFilteredBase = filterByView(base.rows, view);

  const creatorIds = [
    ...new Set(viewFilteredBase.map((r) => r.creatorUserId)),
  ];
  let creatorMap = new Map<string, string | null>();
  if (creatorIds.length > 0) {
    try {
      const db = await getDb();
      const creators = await db.user.findMany({
        where: { id: { in: creatorIds } },
        select: { id: true, username: true },
      });
      creatorMap = new Map(creators.map((c) => [c.id, c.username ?? null]));
    } catch (e) {
      console.error(
        "[live-leaderboards] username hydration failed (rows show id):",
        e,
      );
    }
  }

  const wagerMap = await attachWagerTotals(viewFilteredBase);

  const hydrated: LiveLeaderboardRow[] = viewFilteredBase.map((r) => ({
    ...r,
    creatorUsername: creatorMap.get(r.creatorUserId) ?? null,
    wagerUsd: wagerMap.get(r.id) ?? 0,
  }));

  const rows = rankRows(hydrated, rank, view);

  const viewPrizeUsd = rows.reduce((s, r) => s + r.prizeUsd, 0);
  const viewHouseCostUsd = rows.reduce((s, r) => s + r.houseCostUsd, 0);
  const viewWagerUsd = rows.reduce((s, r) => s + r.wagerUsd, 0);
  const viewHouseSharePct =
    viewPrizeUsd > 0 ? (viewHouseCostUsd / viewPrizeUsd) * 100 : 0;

  return {
    rows,
    view,
    rank,
    activeCount,
    upcomingCount,
    endedCount,
    viewPrizeUsd,
    viewHouseCostUsd,
    viewHouseSharePct,
    viewWagerUsd,
    backendUnavailable: base.backendUnavailable,
    snapshotMs: base.snapshotMs,
  };
}
