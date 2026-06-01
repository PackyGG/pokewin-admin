"use client";

import { Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils/format";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { TILE_COLORS, type AccentColor } from "@/components/modern-panels";

type Sign = "+" | "−" | "=";

/**
 * One row in the cost-breakdown waterfall.
 *
 * Always-visible: icon chip + label + a "why this matters" tooltip +
 * the signed dollar value + a proportional magnitude bar + the
 * %-of-GGR / %-of-wager chips so the operator can see which leak is
 * biggest at a glance.
 *
 * Lives in its own client component because the tooltip (base-ui) needs
 * a client boundary; the parent page stays a server component so the
 * data fetch happens server-side. The lucide icon is pre-rendered on
 * the server and passed as `iconNode` (same pattern as MoneyFlowRow) so
 * the icon's exact accent token stays deterministic and lucide doesn't
 * cross into this bundle for every variant.
 */
export function WaterfallRow({
  label,
  why,
  signedAmount,
  sign,
  maxMag,
  accent,
  iconNode,
  pctOfGgr,
  pctOfWager,
  emphasis = "normal",
  rank,
}: {
  label: string;
  why: string;
  signedAmount: number;
  sign: Sign;
  maxMag: number;
  accent: AccentColor;
  iconNode: React.ReactNode;
  pctOfGgr: number | null;
  pctOfWager: number | null;
  /** `strong` for subtotal / result rows (GGR, P&L) — heavier type + divider. */
  emphasis?: "normal" | "strong";
  /** When set, renders a small "#N biggest leak" badge (top-3 highlight). */
  rank?: number;
}) {
  const colors = TILE_COLORS[accent];
  const widthPct = Math.min(
    100,
    Math.max(2, (Math.abs(signedAmount) / maxMag) * 100),
  );

  return (
    <div
      className={cn(
        "px-1",
        emphasis === "strong" && "rounded-lg bg-muted/40 py-1",
      )}
    >
      <div className="flex w-full items-center gap-3 py-1.5 text-left">
        <div className={cn("shrink-0 rounded-md border p-1.5", colors.bg)}>
          {iconNode}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <div className="flex min-w-0 items-baseline gap-1.5">
              <span
                className={cn(
                  "truncate",
                  emphasis === "strong"
                    ? "text-sm font-semibold"
                    : "text-sm font-medium",
                )}
              >
                {label}
              </span>
              {rank !== undefined && (
                <span className="shrink-0 rounded-full border border-rose-500/30 bg-rose-500/10 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wider text-rose-600 dark:text-rose-400">
                  #{rank} leak
                </span>
              )}
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Info className="size-3 shrink-0 cursor-help text-muted-foreground/60 hover:text-muted-foreground" />
                    }
                  />
                  <TooltipContent className="max-w-sm text-xs leading-relaxed">
                    {why}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            <span
              className={cn(
                "shrink-0 font-mono text-sm font-semibold tabular-nums",
                emphasis === "strong" && "text-base",
                colors.text,
              )}
            >
              {sign === "=" ? "= " : sign}
              {formatCurrency(Math.abs(signedAmount))}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-2">
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted/60">
              <div
                className={cn(
                  "h-full rounded-full bg-current opacity-50",
                  colors.icon,
                )}
                style={{ width: `${widthPct}%` }}
              />
            </div>
            <div className="flex shrink-0 items-center gap-2 text-[10px] tabular-nums text-muted-foreground">
              {pctOfGgr !== null && (
                <span title="% of GGR">
                  {pctOfGgr >= 0 ? "" : "−"}
                  {Math.abs(pctOfGgr).toFixed(1)}% GGR
                </span>
              )}
              {pctOfWager !== null && (
                <span title="% of total wager">
                  {pctOfWager >= 0 ? "" : "−"}
                  {Math.abs(pctOfWager).toFixed(1)}% wager
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
