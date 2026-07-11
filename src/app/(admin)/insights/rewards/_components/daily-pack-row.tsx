"use client";

/**
 * One row in the Daily Packs "Cost by pack" breakdown.
 *
 * REDESIGN (owner: "the daily pack rows are ugly asf"):
 *   - Old row was text-only (name · opens · users — cost, then a full-width
 *     share bar underneath). No pack image, no visual hierarchy.
 *   - New row: a small pack thumbnail on the left (same `CardImage` +
 *     `packs.image_url` source the /packs list uses — see
 *     `EntityNameCell` in `@/components/entity-surface/entity-cells.tsx`),
 *     clean compact stat boxes next to it (Opens / Users / Avg per open),
 *     and a slim share bar.
 *   - The per-pack wager / net-cost reconciliation (previously computed in
 *     `DailyPackRow` but never rendered anywhere in this row) is tucked
 *     behind a small chevron icon-button instead of always taking row
 *     space — click to reveal, mirroring the same "small button reveals
 *     more detail" shape used by the per-card-detail toggle on the user
 *     detail Rewards tab (`reward-pack-opens-section.tsx`).
 *
 * House-POV: giveaway cost (cards out) is what the house pays → rose.
 * Wager collected on those opens is money back → emerald, same as the
 * cost-summary panel above this breakdown.
 */

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { CardImage } from "@/components/card-image";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import type { DailyPackRow } from "@/lib/queries/insights-rewards/daily-packs";

const ROSE = "text-rose-600 dark:text-rose-400";
const EMERALD = "text-emerald-600 dark:text-emerald-400";

/** Small labeled value box — compact sibling of the house `MiniStat`
 *  pattern (users/[id]/rewards-summary-section.tsx), kept local since it's
 *  sized for this row rather than a full panel grid. */
function StatBox({
  label,
  value,
  valueClassName,
}: {
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <div className="min-w-0 rounded-lg border bg-muted/40 px-2 py-1.5">
      <p className="truncate text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </p>
      <p
        className={cn(
          "mt-0.5 truncate text-xs font-semibold tabular-nums",
          valueClassName,
        )}
      >
        {value}
      </p>
    </div>
  );
}

export function DailyPackBreakdownRow({
  pack,
  share,
}: {
  pack: DailyPackRow;
  share: number;
}) {
  const [open, setOpen] = useState(false);
  const netIsHouseCost = pack.netCost >= 0;
  const avgPerOpen = pack.opens > 0 ? pack.giveawayPayout / pack.opens : 0;

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="rounded-lg border bg-muted/20 p-2.5 sm:p-3"
    >
      <div className="flex items-start gap-2.5">
        {/* Pack thumbnail — small + clean, same source/fallback as /packs. */}
        <div className="relative size-10 shrink-0 overflow-hidden rounded-lg bg-muted/40 ring-1 ring-border">
          <CardImage
            src={pack.imageUrl}
            alt={pack.name}
            className="absolute inset-0 size-full"
          />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-medium" title={pack.name}>
              {pack.name}
            </span>
            <div className="flex shrink-0 items-center gap-1">
              <span className={cn("text-sm font-semibold tabular-nums", ROSE)}>
                {formatCurrency(pack.giveawayPayout)}
              </span>
              {/* Small icon-button toggle — replaces a full-width "show
                  detail" bar. Reveals the wager/net-cost reconciliation
                  for this pack, collapsed by default. */}
              <CollapsibleTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={
                      open
                        ? `Hide reconciliation detail for ${pack.name}`
                        : `Show reconciliation detail for ${pack.name}`
                    }
                  />
                }
              >
                <ChevronDown
                  className={cn(
                    "size-3.5 motion-safe:transition-transform motion-safe:duration-200",
                    open && "rotate-180",
                  )}
                />
              </CollapsibleTrigger>
            </div>
          </div>

          <div className="mt-2 grid grid-cols-3 gap-1.5">
            <StatBox label="Opens" value={formatNumber(pack.opens)} />
            <StatBox label="Users" value={formatNumber(pack.claimers)} />
            <StatBox label="Avg / open" value={formatCurrency(avgPerOpen)} />
          </div>

          <div className="mt-2 flex items-center gap-2">
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-rose-500/60 transition-all"
                style={{ width: `${share}%` }}
              />
            </div>
            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
              {share.toFixed(1)}%
            </span>
          </div>
        </div>
      </div>

      <CollapsibleContent>
        <div className="mt-2.5 grid grid-cols-2 gap-1.5 border-t pt-2.5 pl-[50px]">
          <StatBox
            label="Wager collected"
            value={formatCurrency(pack.wager)}
            valueClassName={EMERALD}
          />
          <StatBox
            label="Net cost"
            value={`${netIsHouseCost ? "" : "+"}${formatCurrency(pack.netCost)}`}
            valueClassName={netIsHouseCost ? ROSE : EMERALD}
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
