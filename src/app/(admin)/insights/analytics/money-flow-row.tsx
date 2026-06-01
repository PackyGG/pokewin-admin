"use client";

import { useState } from "react";
import { ChevronDown, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils/format";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { TILE_COLORS } from "@/components/modern-panels";

type Sign = "+" | "−" | "=";
type Accent = "emerald" | "rose" | "blue" | "amber";

/**
 * Single row in the Money Flow waterfall.
 *
 * The header row is always visible — icon chip + label + tooltip
 * explaining "why this matters" + signed dollar value + a proportional
 * bar showing the magnitude relative to the waterfall's max. When
 * `subRows` or `deltaTooltip` is provided, a chevron renders on the
 * right and the row expands into a sub-breakdown.
 *
 * Lives in its own client component because the expander needs
 * `useState`; the parent tab stays a server component so the headline
 * data fetch happens server-side.
 */
export function MoneyFlowRow({
  label,
  value,
  sign,
  maxMag,
  accent,
  iconNode,
  why,
  subRows,
  deltaTooltip,
}: {
  label: string;
  value: number;
  sign: Sign;
  maxMag: number;
  accent: Accent;
  /** Pre-rendered icon node from the server side so we don't need lucide on the client. */
  iconNode: React.ReactNode;
  why: string;
  subRows?: Array<{ label: string; value: number; sign: "+" | "−" }>;
  deltaTooltip?: string;
}) {
  const [open, setOpen] = useState(false);
  const colors = TILE_COLORS[accent];
  const widthPct = Math.min(
    100,
    Math.max(3, (Math.abs(value) / maxMag) * 100),
  );

  const hasExpander = (subRows && subRows.length > 0) || !!deltaTooltip;

  const headerBody = (
    <div className="flex w-full items-center gap-3 py-1.5 text-left">
      <div className={cn("shrink-0 rounded-md border p-1.5", colors.bg)}>
        {iconNode}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <div className="flex min-w-0 items-baseline gap-1.5">
            <span className="truncate text-sm font-medium">{label}</span>
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
              colors.text,
            )}
          >
            {sign === "=" ? "= " : sign}
            {formatCurrency(Math.abs(value))}
          </span>
        </div>
        <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted/60">
          <div
            className={cn("h-full rounded-full bg-current opacity-50", colors.icon)}
            style={{ width: `${widthPct}%` }}
          />
        </div>
      </div>
      {hasExpander && (
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      )}
    </div>
  );

  if (!hasExpander) {
    return <div className="px-1">{headerBody}</div>;
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full rounded-md px-1 transition-colors hover:bg-muted/30"
        aria-expanded={open}
      >
        {headerBody}
      </button>
      {open && (
        <div className="ml-12 mb-2 mt-1 space-y-1.5 rounded-lg border border-border/50 bg-muted/30 p-3 text-xs">
          {subRows && subRows.length > 0 && (
            <div className="space-y-1">
              {subRows.map((sr) => (
                <div
                  key={sr.label}
                  className="flex items-center justify-between gap-3 font-mono tabular-nums"
                >
                  <span className="text-muted-foreground">{sr.label}</span>
                  <span>
                    {sr.sign === "+" ? "+" : "−"}
                    {formatCurrency(Math.abs(sr.value))}
                  </span>
                </div>
              ))}
            </div>
          )}
          {deltaTooltip && (
            <p className="text-[11px] italic leading-relaxed text-muted-foreground">
              {deltaTooltip}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
