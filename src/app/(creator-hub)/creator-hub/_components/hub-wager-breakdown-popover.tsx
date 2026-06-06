"use client";

import { Info } from "lucide-react";
import { formatCurrency } from "@/lib/utils/format";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

/**
 * Wager-only breakdown for the Hub "Affiliate Wager" KPI — wager-side legs
 * from the cohort GGR scan (pack/battle + upgrader).
 */
export function HubWagerBreakdownPopover({
  packBattleWager,
  upgraderWager,
  wagersTotal,
  periodLabel,
}: {
  packBattleWager: number;
  upgraderWager: number;
  wagersTotal: number;
  periodLabel: string;
}) {
  const rows = [
    { label: "Packs & battles wager", total: packBattleWager },
    { label: "Upgrader wager", total: upgraderWager },
  ].filter((r) => r.total > 0);

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="Show affiliate wager breakdown"
            title="Show affiliate wager breakdown"
            className="rounded text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40"
          />
        }
      >
        <Info className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-[340px] max-w-[calc(100vw-2rem)] space-y-2 p-3"
      >
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Affiliate wager breakdown
          </p>
          <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
            {periodLabel}. Code-cohort wager attributed while a creator&apos;s
            code covered the player (7-day windows). Real customers only —
            staff, excluded users, and creator-on-stream play removed.
          </p>
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
            <span>Wagers</span>
            <span className="font-semibold tabular-nums text-foreground">
              +{formatCurrency(wagersTotal)}
            </span>
          </div>
          {rows.length === 0 ? (
            <p className="px-1 text-[10px] text-muted-foreground/60">
              No wager activity.
            </p>
          ) : (
            <ul className="space-y-0.5">
              {rows.map((r) => (
                <li
                  key={r.label}
                  className="flex items-center justify-between gap-2 rounded px-1 py-0.5 text-[11px] hover:bg-muted/40"
                >
                  <span className="truncate text-muted-foreground">
                    {r.label}
                  </span>
                  <span className="shrink-0 tabular-nums text-foreground/80">
                    {formatCurrency(r.total)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
