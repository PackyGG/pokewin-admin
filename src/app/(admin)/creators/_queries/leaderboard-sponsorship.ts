import "server-only";

import { inArray } from "drizzle-orm";
import { adminDrizzle } from "@/lib/drizzle";
import { admin_leaderboard_sponsorship } from "@/lib/db-schema/admin/schema";
import { toNumber } from "@/lib/utils/decimal";
import { LB_HOUSE_SHARE } from "@/lib/deal-economics";

/**
 * Admin-side "sponsored %" per creator (affiliate) leaderboard, read
 * from the admin DB's `admin_leaderboard_sponsorship` table.
 *
 * Returns a Map keyed by the backend leaderboard id → percentage
 * (0–100). Leaderboards with no row are simply absent from the map;
 * callers default them to 100% (full cost counted) — the
 * Leaderboard Cost tile must not silently drop a leaderboard just
 * because nobody has annotated it yet.
 *
 * Used by both the /creators/leaderboards table (to show + edit each
 * row's %) and getLeaderboardCostTotal (to weight the cost sum).
 */
export async function getLeaderboardSponsorshipMap(
  leaderboardIds: string[],
): Promise<Map<string, number>> {
  if (leaderboardIds.length === 0) return new Map();
  const rows = await adminDrizzle
    .select({
      leaderboard_id: admin_leaderboard_sponsorship.leaderboard_id,
      sponsored_percentage:
        admin_leaderboard_sponsorship.sponsored_percentage,
    })
    .from(admin_leaderboard_sponsorship)
    .where(
      inArray(admin_leaderboard_sponsorship.leaderboard_id, leaderboardIds),
    );
  return new Map(
    rows.map((r) => [r.leaderboard_id, toNumber(r.sponsored_percentage)]),
  );
}

/** One leaderboard-prize bucket: a board id (or null) + its prize magnitude. */
type LeaderboardPrizeBucket = {
  /** Backend leaderboard id from the prize row's `metadata.leaderboard_id`. */
  leaderboardId: string | null;
  /** Σ |amount| of the prize rows in this bucket (house magnitude, ≥ 0). */
  prize: number;
};

/** The house-share split of a set of leaderboard prize buckets. */
type LeaderboardPrizeSplit = {
  /** Full prize pool paid out (100%, no weighting) — Σ bucket.prize. */
  full: number;
  /**
   * House-funded "our cut" — `full × 50%` (the canonical owner rule: the
   * house always pays half of every leaderboard prize pool).
   */
  ourCut: number;
  /**
   * On-site remainder — `full − ourCut` = `full × 50%`, the half the
   * creator funds off-site (NOT a house cost for the "our cut" accounting).
   */
  onSite: number;
};

/**
 * Split a set of leaderboard-prize buckets into the house-funded "our cut"
 * and the on-site remainder at the canonical 50% house share (owner rule:
 * the house always pays half of every leaderboard prize pool). Replaces the
 * old admin per-board "sponsored %" (which defaulted to 100% and over-counted).
 *
 * THE SINGLE source of the leaderboard-prize house-share split for the
 * dashboard leaderboard-prize lines, so the Reward Costs box (which keeps
 * `onSite`) and the Creators Costs box (which keeps `ourCut`) derive their
 * split from ONE implementation and reconcile by construction: for any
 * single set of buckets, `ourCut + onSite === full`. Identical 50% share to
 * `leaderboard-cost.ts` `houseCoveredUsd` / `leaderboardHouseCost`.
 *
 * `sponsorship` is retained for signature compatibility with the callers but
 * is no longer read — the split is a flat 50%.
 */
function splitLeaderboardPrizesBySponsorship(
  buckets: LeaderboardPrizeBucket[],
  _sponsorship: Map<string, number>,
): LeaderboardPrizeSplit {
  let full = 0;
  for (const b of buckets) {
    full += b.prize;
  }
  // The house always pays 50%; onSite is the complement so the two always
  // sum back to the full pool.
  const ourCut = full * LB_HOUSE_SHARE;
  return { full, ourCut, onSite: full - ourCut };
}
