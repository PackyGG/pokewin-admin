import {
  resolveIntendedHitRate,
  TAGGED_WRITE_WINRATE_TOLERANCE,
} from "@/app/(admin)/packs/_lib/auto-targets";
import {
  getPackRiskRows,
  type PackRiskRow,
} from "../../_queries/doctor";

/**
 * Retune V2 rail seed — the workspace's left pack list, seeded ENTIRELY from
 * the 60s-cached ADMIN risk snapshot (`getPackRiskRows`: `pack_risk_scores`
 * via `unstable_cache`, tag `pack-studio-overview`, + ONE indexed MAIN PK
 * meta probe). NO 183-pack solver sweep, NO card lists, NO images — a pack's
 * plan is computed on selection via `planPackTune`, single-pack.
 */

export type RetuneRailRow = PackRiskRow & {
  /**
   * The pack's intended hit-rate (`resolveIntendedHitRate(name, tags)` — DB
   * tags first, name-prefix fallback), or null for an untagged pack. Drives
   * the `%1/%5/%10` tag badge.
   */
  tag: number | null;
  /**
   * True when the pack is tagged AND its LIVE win-rate (snapshot truth as of
   * `computedAt`) misses the tag by more than the write-time acceptance
   * (`TAGGED_WRITE_WINRATE_TOLERANCE`, 0.1pp) — the rail's amber off-tag
   * warning ("live pool pays X% winners but the tag says Y%").
   */
  offTagLive: boolean;
};

/**
 * Rail rows for the Retune V2 workspace: every ACTIVE, priced pack from the
 * risk snapshot, each carrying its resolved tag + live off-tag flag. Degrades
 * to `{ rows: [], error }` on failure instead of throwing (the page renders
 * an EmptyState with retry); `rows: []` with `error: null` means "no snapshot
 * yet — compute one in Pack Doctor".
 */
export async function getRetuneRailRows(): Promise<{
  rows: RetuneRailRow[];
  error: string | null;
}> {
  try {
    const rows = await getPackRiskRows();
    const out: RetuneRailRow[] = rows
      .filter((r) => r.active === true && r.price > 0)
      .map((r) => {
        const tag = resolveIntendedHitRate(r.name, r.tags);
        return {
          ...r,
          tag,
          offTagLive:
            tag !== null &&
            Math.abs(r.winRate - tag) > TAGGED_WRITE_WINRATE_TOLERANCE,
        };
      });
    return { rows: out, error: null };
  } catch (err) {
    return {
      rows: [],
      error:
        err instanceof Error ? err.message : "Couldn't load the pack rail.",
    };
  }
}
