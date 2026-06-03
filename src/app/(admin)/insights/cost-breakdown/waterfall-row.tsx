"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils/format";
import { SEMANTIC_TONES, type SemanticTone } from "./_components";

type Sign = "+" | "−" | "=";

/**
 * One row in the cost-breakdown waterfall — redesigned for the
 * comprehension-first remake.
 *
 * The waterfall is organised into bands (incoming → gaming payouts → GGR
 * → rewards → NGR → held/liabilities → realized P&L). Each row shows an
 * icon chip + label + an optional "i" info popover + the signed dollar
 * value + a proportional magnitude bar + the %-of-GGR / %-of-wager chips.
 *
 * Three things make the story scannable here:
 *   • Semantic tone (not one flat rose): money the house KEEPS is
 *     emerald, realized money-back is rose, HELD/unrealized liability is
 *     amber (so it never reads like a realized loss), the base wager is
 *     blue, the honest leftover is muted.
 *   • Emphasis tiers: `result` (the realized P&L) is the loudest row;
 *     `subtotal` (GGR / NGR) is a tinted checkpoint; normal rows are
 *     quiet line items. The biggest leaks carry a "#N" badge.
 *   • Client boundary because the info popover (base-ui) needs one; the
 *     parent page stays a server component so the fetch is server-side.
 *     The lucide icon is pre-rendered on the server and passed as
 *     `iconNode` so lucide doesn't cross into this bundle per variant.
 */
export function WaterfallRow({
  label,
  signedAmount,
  sign,
  maxMag,
  tone,
  iconNode,
  pctOfGgr,
  pctOfWager,
  emphasis = "normal",
  rank,
  info,
}: {
  label: string;
  signedAmount: number;
  sign: Sign;
  maxMag: number;
  tone: SemanticTone;
  iconNode: React.ReactNode;
  pctOfGgr: number | null;
  pctOfWager: number | null;
  /** `subtotal` = GGR/NGR checkpoint, `result` = the final P&L (loudest). */
  emphasis?: "normal" | "subtotal" | "result";
  /** When set, renders a small "#N biggest leak" badge (top-3 highlight). */
  rank?: number;
  /** Optional info-popover node rendered inline after the label. */
  info?: React.ReactNode;
}) {
  const t = SEMANTIC_TONES[tone];
  const widthPct = Math.min(
    100,
    Math.max(2, (Math.abs(signedAmount) / maxMag) * 100),
  );
  const isStrong = emphasis === "subtotal" || emphasis === "result";

  return (
    <div
      className={cn(
        "rounded-lg px-2 transition-colors",
        emphasis === "result" &&
          cn("py-2 ring-1 ring-inset", t.face, t.ring),
        emphasis === "subtotal" && cn("py-1.5", t.face),
        emphasis === "normal" && "py-1 hover:bg-muted/30",
      )}
    >
      <div className="flex w-full items-center gap-2.5 text-left sm:gap-3">
        <div
          className={cn(
            "flex shrink-0 items-center justify-center rounded-md",
            emphasis === "result" ? "size-8" : "size-7",
            t.chip,
          )}
        >
          {iconNode}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <span
                className={cn(
                  "truncate",
                  emphasis === "result"
                    ? "text-sm font-bold sm:text-[15px]"
                    : isStrong
                      ? "text-sm font-semibold"
                      : "text-[13px] font-medium",
                )}
              >
                {label}
              </span>
              {rank !== undefined && (
                <span className="shrink-0 rounded-full border border-rose-500/30 bg-rose-500/10 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wider text-rose-600 dark:text-rose-400">
                  #{rank} leak
                </span>
              )}
              {info}
            </div>
            <span
              className={cn(
                "shrink-0 font-mono font-semibold tabular-nums",
                emphasis === "result"
                  ? "text-base sm:text-lg"
                  : isStrong
                    ? "text-sm sm:text-[15px]"
                    : "text-[13px]",
                t.text,
              )}
            >
              {sign === "=" ? "= " : sign}
              {formatCurrency(Math.abs(signedAmount))}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-2">
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted/60">
              <div
                className={cn("h-full rounded-full", t.bar)}
                style={{ width: `${widthPct}%` }}
              />
            </div>
            <div className="flex shrink-0 items-center gap-1.5 text-[10px] tabular-nums text-muted-foreground">
              {pctOfGgr !== null && (
                <span title="% of GGR">
                  {pctOfGgr >= 0 ? "" : "−"}
                  {Math.abs(pctOfGgr).toFixed(1)}% GGR
                </span>
              )}
              {pctOfWager !== null && (
                <span title="% of total wager" className="hidden sm:inline">
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

/**
 * A band header inside the waterfall — a thin labelled divider that names
 * the next group of rows (e.g. "Reward & marketing giveaways") so the
 * running total reads as distinct chapters instead of one long list.
 */
export function WaterfallBand({
  label,
  hint,
}: {
  label: string;
  hint?: string;
}) {
  return (
    <div className="flex items-center gap-2 px-2 pb-0.5 pt-3 first:pt-1">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      {hint && (
        <span className="hidden truncate text-[10px] text-muted-foreground/60 sm:inline">
          · {hint}
        </span>
      )}
      <span aria-hidden className="h-px flex-1 bg-border/60" />
    </div>
  );
}
