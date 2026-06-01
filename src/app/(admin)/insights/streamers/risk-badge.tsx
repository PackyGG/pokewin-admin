import { cn } from "@/lib/utils";

/**
 * Risk-score badge. Color thresholds from CLAUDE.md guidance:
 *   - 0–29  → emerald (low risk, looks clean)
 *   - 30–49 → cyan    (worth a glance but not flagged)
 *   - 50–74 → amber   (probably worth an admin look)
 *   - 75+   → rose    (likely abuse — investigate)
 *
 * Note: rose for high-risk uses the "user winning / costing us" House-POV
 * mapping — a high risk score = a creator costing us money via abuse.
 */
export function RiskBadge({ score }: { score: number }) {
  const colorClass =
    score >= 75
      ? "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30"
      : score >= 50
        ? "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30"
        : score >= 30
          ? "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400 border-cyan-500/30"
          : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30";

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-semibold tabular-nums",
        colorClass,
      )}
      title={`Risk score: ${score}/100`}
    >
      {score}
    </span>
  );
}
