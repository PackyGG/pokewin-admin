import { ArrowUp, ArrowDown, Minus } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Trend chip for a period-vs-previous-period KPI comparison.
 *
 * `houseFavorable` decides which direction is good FROM THE HOUSE'S
 * PERSPECTIVE per CLAUDE.md's color rule. Callers pass:
 *   • houseFavorable: "up"   — for metrics where bigger = better for the
 *                              house (deposits, wager, GGR, NGR, signups).
 *                              Up = emerald, down = rose.
 *   • houseFavorable: "down" — for metrics where bigger = worse for the
 *                              house (withdrawals). Up = rose, down =
 *                              emerald.
 *   • houseFavorable: "neutral" — neither direction is good or bad
 *                              (unique active users is just a footprint).
 *                              Always rendered neutral gray.
 *
 * `previous === null` (lifetime period, no comparison window) renders a
 * muted "—" chip so the layout slot is still filled.
 */
export function DeltaChip({
  current,
  previous,
  houseFavorable,
}: {
  current: number;
  previous: number | null;
  houseFavorable: "up" | "down" | "neutral";
}) {
  if (previous === null) {
    return (
      <span className="inline-flex items-center gap-0.5 rounded-full bg-muted/50 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
        <Minus className="size-3" />
        n/a
      </span>
    );
  }
  // Treat sub-cent / sub-unit deltas as flat to avoid noise from
  // floating-point dust on tiny lifetime denominators.
  const delta = current - previous;
  const ref = Math.max(Math.abs(previous), 1);
  const pct = (delta / ref) * 100;
  const sign = pct > 0.05 ? "up" : pct < -0.05 ? "down" : "flat";
  const Icon = sign === "up" ? ArrowUp : sign === "down" ? ArrowDown : Minus;

  let tone: "emerald" | "rose" | "muted";
  if (sign === "flat" || houseFavorable === "neutral") {
    tone = "muted";
  } else if (houseFavorable === "up") {
    tone = sign === "up" ? "emerald" : "rose";
  } else {
    tone = sign === "down" ? "emerald" : "rose";
  }

  const toneClass =
    tone === "emerald"
      ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
      : tone === "rose"
        ? "bg-rose-500/10 text-rose-600 dark:text-rose-400"
        : "bg-muted/50 text-muted-foreground";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums",
        toneClass,
      )}
      title={`${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% vs previous period`}
    >
      <Icon className="size-3" />
      {pct >= 0 ? "+" : ""}
      {Math.abs(pct) < 100 ? pct.toFixed(1) : pct.toFixed(0)}%
    </span>
  );
}
