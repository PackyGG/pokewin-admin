import { cn } from "@/lib/utils";
import type { RiskTier } from "@/app/(admin)/insights/edge-calc/risk";

/**
 * Pack-Studio's ONE risk-level bar (owner ask 2026-07-11: "show me a lvl bar
 * instead of just a weird number") — the game-site-style 5-segment volatility
 * meter for the T1..T5 tier, shared by the builder preview and the retune
 * plan panel so the two surfaces can never disagree on what a tier looks
 * like. Escalation palette matches the tier badges in `doctor-table.tsx` /
 * `rail-row.tsx` (cool → rose). Volatility is a PRODUCT dial, not a money
 * verdict — no house-POV coloring here.
 */

const TIER_WORD: Record<RiskTier, string> = {
  T1: "calm",
  T2: "steady",
  T3: "lively",
  T4: "swingy",
  T5: "wild",
};

/** Per-rung SOLID fill (segment k always wears rung k's color when lit). */
const SEGMENT_FILL: Record<RiskTier, string> = {
  T1: "bg-cyan-500",
  T2: "bg-emerald-500",
  T3: "bg-amber-500",
  T4: "bg-orange-500",
  T5: "bg-rose-500",
};

const TIER_TEXT: Record<RiskTier, string> = {
  T1: "text-cyan-600 dark:text-cyan-400",
  T2: "text-emerald-600 dark:text-emerald-400",
  T3: "text-amber-600 dark:text-amber-400",
  T4: "text-orange-600 dark:text-orange-400",
  T5: "text-rose-600 dark:text-rose-400",
};

const TIERS: RiskTier[] = ["T1", "T2", "T3", "T4", "T5"];

/** Unknown/legacy tier strings degrade to level 0 (all segments unlit). */
function tierLevel(tier: string): number {
  const idx = TIERS.indexOf(tier as RiskTier);
  return idx === -1 ? 0 : idx + 1;
}

export function RiskLevelBar({
  tier,
  cv,
  score,
  showLabel = true,
  className,
}: {
  /** The pack's volatility tier ("T1".."T5"). */
  tier: string;
  /** Optional CV suffix, e.g. 3.42 → "CV 3.42" (muted). */
  cv?: number;
  /** Optional 0–100 composite score suffix (muted). */
  score?: number;
  /** Render the tier word next to the bar (default true). */
  showLabel?: boolean;
  className?: string;
}) {
  const level = tierLevel(tier);
  const top = level > 0 ? TIERS[level - 1]! : null;
  return (
    <span
      className={cn("inline-flex items-center gap-2", className)}
      role="meter"
      aria-valuemin={1}
      aria-valuemax={5}
      aria-valuenow={Math.max(1, level)}
      aria-label={`Risk level ${level} of 5${top ? ` (${tier} · ${TIER_WORD[top]})` : ""}`}
    >
      <span className="flex items-center gap-0.5">
        {TIERS.map((t, i) => (
          <span
            key={t}
            className={cn(
              "h-1.5 w-4 rounded-sm motion-safe:transition-colors",
              i < level ? SEGMENT_FILL[t] : "bg-muted",
            )}
          />
        ))}
      </span>
      {showLabel && top !== null && (
        <span
          className={cn(
            "text-xs font-semibold leading-none",
            TIER_TEXT[top],
          )}
        >
          {tier} · {TIER_WORD[top]}
        </span>
      )}
      {(cv !== undefined || score !== undefined) && (
        <span className="text-[11px] leading-none text-muted-foreground">
          {cv !== undefined ? `CV ${cv.toFixed(2)}` : ""}
          {cv !== undefined && score !== undefined ? " · " : ""}
          {score !== undefined ? `${Math.round(score)}/100` : ""}
        </span>
      )}
    </span>
  );
}
