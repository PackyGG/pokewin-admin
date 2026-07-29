import { AFFILIATE_LEVEL_COLORS, AFFILIATE_LEVEL_LABELS } from "@/lib/constants";

/**
 * Read-only affiliate-level chip. This used to be an editable select
 * wired to updateAffiliateLevel, but that action was a silent no-op:
 * there is NO per-user level column anywhere in the MAIN schema — the
 * level is always DERIVED from lifetime wager volume vs. the
 * `affiliate_level_configs` thresholds (see src/lib/queries/my-profile.ts,
 * resolveAffiliateLevel). The "edit" only bumped updated_at, toasted
 * "Level updated" and silently reverted on the next revalidation, so the
 * control is now display-only. The ladder itself is edited on
 * /creators/settings (updateLevelConfig).
 */
export function InlineLevelSelect({
  currentLevel,
}: {
  userId: string;
  currentLevel: number;
}) {
  return (
    <span
      className={`inline-flex h-5 items-center rounded-4xl px-2 text-xs font-medium ${AFFILIATE_LEVEL_COLORS[currentLevel] ?? ""}`}
    >
      {AFFILIATE_LEVEL_LABELS[currentLevel] ?? `Level ${currentLevel}`}
    </span>
  );
}
