import "server-only";

import { adminDb } from "@/lib/admin-db";
import { toNumber } from "@/lib/utils/decimal";

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
  const rows = await adminDb.admin_leaderboard_sponsorship.findMany({
    where: { leaderboard_id: { in: leaderboardIds } },
    select: { leaderboard_id: true, sponsored_percentage: true },
  });
  return new Map(
    rows.map((r) => [r.leaderboard_id, toNumber(r.sponsored_percentage)]),
  );
}

/** One leaderboard-prize bucket: a board id (or null) + its prize magnitude. */
export type LeaderboardPrizeBucket = {
  /** Backend leaderboard id from the prize row's `metadata.leaderboard_id`. */
  leaderboardId: string | null;
  /** Σ |amount| of the prize rows in this bucket (house magnitude, ≥ 0). */
  prize: number;
};

/** The sponsored-% split of a set of leaderboard prize buckets. */
export type LeaderboardPrizeSplit = {
  /** Full prize pool paid out (100%, no weighting) — Σ bucket.prize. */
  full: number;
  /**
   * House-funded "our cut" — Σ bucket.prize × (sponsored% / 100), the share
   * the house actually covers after the creator's off-site sponsor %.
   */
  ourCut: number;
  /**
   * On-site / un-sponsored remainder — `full − ourCut` = Σ bucket.prize ×
   * ((100 − sponsored%) / 100), the slice the creator funds off-site (NOT a
   * house cost for the leaderboard "our cut" accounting).
   */
  onSite: number;
};

/**
 * Split a set of leaderboard-prize buckets into the house-funded "our cut"
 * and the on-site (un-sponsored) remainder, using each board's admin-set
 * sponsored % (defaulting to 100% — full house cost — when a board is
 * un-annotated or carries no leaderboard id).
 *
 * THE SINGLE source of the sponsored-% house-share weighting for the
 * dashboard leaderboard-prize lines, so the Reward Costs box (which keeps
 * `onSite`) and the Creators Costs box (which keeps `ourCut`) derive their
 * split from ONE implementation and reconcile by construction: for any
 * single set of buckets, `ourCut + onSite === full`. Identical weighting +
 * default convention to `leaderboard-cost.ts` `houseCoveredUsd`.
 *
 * `sponsorship` is the map from `getLeaderboardSponsorshipMap` keyed on the
 * buckets' leaderboard ids; pass an empty map (the resilient fallback) to
 * treat every board as 100% (`ourCut === full`, `onSite === 0`).
 */
export function splitLeaderboardPrizesBySponsorship(
  buckets: LeaderboardPrizeBucket[],
  sponsorship: Map<string, number>,
): LeaderboardPrizeSplit {
  let full = 0;
  let ourCut = 0;
  for (const b of buckets) {
    full += b.prize;
    // No annotation / no board id → 100% (full house cost). Clamp to 0–100.
    const pct =
      b.leaderboardId != null
        ? Math.min(100, Math.max(0, sponsorship.get(b.leaderboardId) ?? 100))
        : 100;
    ourCut += b.prize * (pct / 100);
  }
  // onSite is the complement so the two always sum back to the full pool.
  return { full, ourCut, onSite: full - ourCut };
}
