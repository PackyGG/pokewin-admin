import { cn } from "@/lib/utils";

/**
 * Faithful replica of the PLAYER-FACING pack risk bar shown on the live game
 * site (packy.gg) — the 4-segment green→red difficulty meter with the white
 * needle that sits under every pack card. It lets an operator see EXACTLY how a
 * pack's risk indicator will look to players before it is pushed.
 *
 * This is driven by the pack's `difficulty` field (0..1), NOT by the admin's
 * internal T1..T5 CV risk tier (that stays a separate, house-side read). The
 * two are different things: `difficulty` is the product/marketing dial that
 * players see; the CV tier is the true statistical volatility.
 *
 * The colors, tiering, needle position and empty-track color are copied
 * VERBATIM from the frontend repo so the preview can never drift from reality:
 *   • colors / tiering / needle → `src/lib/utils/packs/pack-difficulty.ts`
 *   • segment bar render        → `src/components/shared/pack-card-display.tsx`
 *   • tier labels               → `src/components/packs/risk-level-slider.tsx`
 *
 * Faithful edge cases mirrored from `pack-card-display.tsx`:
 *   • difficulty === null OR 0  → NO bar shows on-site (a pack with `difficulty`
 *     null renders no rarity bar in production), so we render the "hidden" state
 *     rather than a misleading level-1 bar. This matches `buildPack`, which
 *     persists `difficulty || null` (0 ⇒ null).
 */

// green → yellow → light-orange → dark-orange/red (Packs Grid v3 palette).
const PACK_RARITY_COLORS = ["#6FE39A", "#EFD948", "#F59140", "#E04A2F"] as const;
const PACK_RARITY_EMPTY_COLOR = "rgba(255,255,255,0.08)";
const TIER_LABELS = ["Low", "Mild", "Medium", "High"] as const;
const TIER_COUNT = PACK_RARITY_COLORS.length;

/** floor(difficulty · 4) + 1, clamped to 1..4 — matches `resolvePackRarityTier`. */
function rarityTier(difficulty: number): 1 | 2 | 3 | 4 {
  const v = Math.min(Math.max(difficulty, 0), 0.9999);
  const tier = Math.floor(v * TIER_COUNT) + 1;
  return Math.min(Math.max(tier, 1), TIER_COUNT) as 1 | 2 | 3 | 4;
}

/** clamp(difficulty · 100, 1, 99) — matches `getPackDifficultyIndicatorPosition`. */
function indicatorPos(difficulty: number): number {
  return Math.min(Math.max(difficulty * 100, 1), 99);
}

/** Hex → "r, g, b" for the on-site segment glow (`0 0 3px rgba(...,0.45)`). */
function hexToRgb(hex: string): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `${r}, ${g}, ${b}`;
}

export function PackRiskBarPreview({
  difficulty,
  showValue = true,
  className,
}: {
  /** The pack's on-site difficulty (0..1). null/0 → no bar shows on-site. */
  difficulty: number | null;
  /** Hide the duplicate numeric value when the parent renders its own score. */
  showValue?: boolean;
  className?: string;
}) {
  const hasBar = typeof difficulty === "number" && difficulty > 0;

  if (!hasBar) {
    return (
      <div className={cn("space-y-2", className)}>
        <div
          className="grid w-full gap-1"
          style={{ gridTemplateColumns: `repeat(${TIER_COUNT}, 1fr)` }}
          aria-hidden
        >
          {Array.from({ length: TIER_COUNT }).map((_, i) => (
            <span
              key={i}
              className="block h-1 rounded-sm"
              style={{ backgroundColor: PACK_RARITY_EMPTY_COLOR }}
            />
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          No risk bar — players won&apos;t see one. Raise the level above 0% to
          add it.
        </p>
      </div>
    );
  }

  const tier = rarityTier(difficulty);
  const color = PACK_RARITY_COLORS[tier - 1];
  const label = TIER_LABELS[tier - 1];
  const pos = indicatorPos(difficulty);

  return (
    <div
      className={cn("space-y-2", className)}
      role="img"
      aria-label={`On-site risk ${label} (${tier} of ${TIER_COUNT})`}
    >
      <div className="relative w-full">
        <div
          className="grid w-full gap-1"
          style={{ gridTemplateColumns: `repeat(${TIER_COUNT}, 1fr)` }}
        >
          {Array.from({ length: TIER_COUNT }).map((_, i) => {
            const on = i < tier;
            return (
              <span
                key={i}
                className="block h-1 rounded-sm motion-safe:transition-colors"
                style={{
                  backgroundColor: on ? color : PACK_RARITY_EMPTY_COLOR,
                  boxShadow: on ? `0 0 3px rgba(${hexToRgb(color)}, 0.45)` : undefined,
                }}
              />
            );
          })}
        </div>
        {/* White needle at the exact difficulty position (on-site parity). */}
        <span
          className="pointer-events-none absolute -top-[3px] h-[10px] w-[3px] -translate-x-1/2 rounded-[1px] bg-white"
          style={{ left: `${pos}%` }}
        />
      </div>
      <div className="flex items-center justify-between text-xs">
        <span className="font-semibold" style={{ color }}>
          {label}
        </span>
        {showValue ? (
          <span className="tabular-nums text-muted-foreground">
            {Math.round(difficulty * 100)}%
          </span>
        ) : null}
      </div>
    </div>
  );
}
