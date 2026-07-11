import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Side-by-side "with X vs without X" cohort comparison card. Used by
 * the per-category tabs (deposit-bonus claimants vs non-claimants,
 * signup-bonus claimants' first deposit size vs non-claimants', etc.)
 * to highlight a behavioural delta between two cohorts.
 *
 * House-POV: numbers here are not by themselves house cost — they're
 * deposit / wager amounts. We render them muted-foreground so the
 * panel doesn't pretend a cohort delta is a rose-coded house cost.
 * The lift% pill is rose when the LEFT side leads (claimants deposit
 * MORE → more rose-cost downstream).
 */
export function CohortCompareCard({
  title,
  subtitle,
  leftLabel,
  leftValue,
  leftSub,
  rightLabel,
  rightValue,
  rightSub,
  /**
   * Optional lift percentage. Positive → left side is larger. Rendered
   * as a centre pill with directional arrow. Defaults to undefined →
   * pill is hidden.
   */
  liftPct,
}: {
  title: string;
  subtitle?: string;
  leftLabel: string;
  leftValue: string;
  leftSub?: string;
  rightLabel: string;
  rightValue: string;
  rightSub?: string;
  liftPct?: number;
}) {
  const liftAvailable = liftPct !== undefined && Number.isFinite(liftPct);
  const liftAbs = liftAvailable ? Math.abs(liftPct) : 0;
  const liftIsRise = liftAvailable && (liftPct as number) >= 0;
  return (
    <div className="rounded-2xl border bg-card p-4 sm:p-5">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </p>
        {subtitle && (
          <p className="mt-0.5 text-[11px] text-muted-foreground/80">
            {subtitle}
          </p>
        )}
        <div className="mt-3 grid grid-cols-[1fr_auto_1fr] items-center gap-2 sm:gap-4">
          <CohortSide
            label={leftLabel}
            value={leftValue}
            sub={leftSub}
            align="right"
          />
          {liftAvailable ? (
            <div className="flex flex-col items-center gap-1">
              <ArrowRight
                className={cn(
                  "size-4",
                  liftIsRise ? "text-rose-500" : "text-muted-foreground",
                )}
              />
              <span
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[10px] font-semibold tabular-nums",
                  liftIsRise
                    ? "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400"
                    : "border-border bg-muted text-muted-foreground",
                )}
              >
                {liftIsRise ? "+" : "−"}
                {liftAbs.toFixed(0)}%
              </span>
            </div>
          ) : (
            <ArrowRight className="size-4 text-muted-foreground" />
          )}
          <CohortSide
            label={rightLabel}
            value={rightValue}
            sub={rightSub}
            align="left"
          />
        </div>
      </div>
    </div>
  );
}

function CohortSide({
  label,
  value,
  sub,
  align,
}: {
  label: string;
  value: string;
  sub?: string;
  align: "left" | "right";
}) {
  return (
    <div
      className={cn(
        "min-w-0 space-y-0.5",
        align === "right" ? "text-right" : "text-left",
      )}
    >
      <p className="truncate text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="truncate text-lg font-bold leading-tight tracking-tight tabular-nums sm:text-xl">
        {value}
      </p>
      {sub && (
        <p className="truncate text-[10px] text-muted-foreground">{sub}</p>
      )}
    </div>
  );
}
