"use client";

import { Info } from "lucide-react";

import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils/format";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

/**
 * GGR breakdown "list-down" for the /creators "Net Code-User GGR" tile —
 * the cohort-wide twin of the dashboard's GgrStatCard popover
 * (revenue-stat-card.tsx → GgrBreakdownPopover). Same chrome, same
 * Wagers / Payouts sectioning, same bottom GGR math, House-POV colors.
 *
 * Where the dashboard popover decomposes the SITE-wide GGR, this one
 * decomposes the roster-wide CODE-USER GGR: the same canonical legs
 * (pack/battle stake + upgrader stake on the wager side; pack/battle
 * inventory wins + battle refunds + upgrader payout on the payout side),
 * summed across every creator's attributed cohort over the active
 * window. The legs reconcile to the tile's headline by construction
 * (`wagersTotal − payoutsTotal === ggr`), so the bottom line always
 * matches the tile.
 *
 * Server-safe: takes serializable number props only (no function props
 * cross the RSC boundary) and is rendered from the tile's `action` slot
 * on the server-side /creators page.
 */
export function NetGgrBreakdownPopover({
  packBattleWager,
  upgraderWager,
  inventoryPayout,
  battleRefundLedger,
  upgraderPayout,
  wagersTotal,
  payoutsTotal,
  ggr,
  periodLabel,
}: {
  /** Ledger pack/battle stake (wager-side). */
  packBattleWager: number;
  /** Upgrader stake (wager-side). */
  upgraderWager: number;
  /** Pack/battle wins valued from inventory (payout-side). */
  inventoryPayout: number;
  /** Ledger cash gaming-payout legs — battle refunds (payout-side). */
  battleRefundLedger: number;
  /** Upgrader payout (payout-side). */
  upgraderPayout: number;
  /** Σ wager-side legs. */
  wagersTotal: number;
  /** Σ payout-side legs. */
  payoutsTotal: number;
  /** wagersTotal − payoutsTotal — matches the tile's headline GGR. */
  ggr: number;
  /** Friendly window label (e.g. "Last 24h"). */
  periodLabel: string;
}) {
  const ggrIsProfit = ggr >= 0;

  // Hide zero-total legs so the list stays readable on quiet windows
  // (e.g. a window with no upgrader plays / battles). The bottom math
  // still reflects the full sums.
  const wagers = [
    { label: "Packs & battles wager", total: packBattleWager },
    { label: "Upgrader wager", total: upgraderWager },
  ].filter((r) => r.total > 0);
  const payouts = [
    { label: "Packs & battles wins (inventory)", total: inventoryPayout },
    { label: "Battle refunds (cash)", total: battleRefundLedger },
    { label: "Upgrader payout", total: upgraderPayout },
  ].filter((r) => r.total > 0);

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="Show GGR breakdown"
            title="Show GGR breakdown"
            className="rounded text-muted-foreground/60 transition-colors hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40"
          />
        }
      >
        <Info className="size-3" />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-[340px] max-w-[calc(100vw-2rem)] space-y-2 p-3"
      >
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Net Code-User GGR breakdown
          </p>
          <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
            {periodLabel}. GGR = wager − (pack/battle wins + battle
            refunds + upgrader payout), summed across every creator&apos;s
            code cohort while their code was active (7-day attribution
            windows). Wins are valued from inventory (the cards kept), not
            a ledger payout; upgrader comes from its own table.
            Card/voucher conversions are neutral and excluded. Real
            customers only (staff + excluded users dropped, all creator
            play removed, borrow plays removed).
          </p>
        </div>

        {/* Wager-side legs — muted tint (wagers are flow-IN, not a house
            gain on their own). Section header carries the bucket total. */}
        <BreakdownSection title="Wagers" total={wagersTotal} rows={wagers} tone="wager" />

        {/* Payout-side legs — rose tint (money flowing OUT of the house).
            The headline's "negative" component lives here. */}
        <BreakdownSection
          title="Payouts"
          total={payoutsTotal}
          rows={payouts}
          tone="payout"
        />

        {/* Bottom math: wagersTotal − payoutsTotal = GGR. House-POV color
            on the final line (positive → emerald, negative → rose) per
            CLAUDE.md. Uses the passed-through `ggr` (which the query
            derives from these same legs) so it matches the rows above by
            construction. */}
        <div className="border-t border-border/60 pt-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold uppercase tracking-wider">GGR</span>
            <span
              className={cn(
                "font-bold tabular-nums",
                ggrIsProfit ? "text-emerald-400" : "text-rose-400",
              )}
            >
              {ggrIsProfit ? "+" : "−"}
              {formatCurrency(Math.abs(ggr))}
            </span>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * One bucket (Wagers or Payouts) inside the breakdown popover — mirrors
 * the dashboard's `BreakdownSection`. The section header carries the
 * bucket total + leg count so admins can scan top-to-bottom without
 * re-summing.
 *
 * `tone` is purely the amount color:
 *   • "wager"  — muted (wagers are flow-in, not a house P&L event).
 *   • "payout" — rose (every payout shrinks the house margin).
 */
function BreakdownSection({
  title,
  total,
  rows,
  tone,
}: {
  title: string;
  total: number;
  rows: { label: string; total: number }[];
  tone: "wager" | "payout";
}) {
  const totalColor = tone === "payout" ? "text-rose-400" : "text-foreground";
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
        <span>
          {title}
          {rows.length > 0 && (
            <span className="ml-1 text-muted-foreground/60">· {rows.length}</span>
          )}
        </span>
        <span className={cn("font-semibold tabular-nums", totalColor)}>
          {tone === "payout" ? "−" : "+"}
          {formatCurrency(total)}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="px-1 text-[10px] text-muted-foreground/60">No activity.</p>
      ) : (
        <ul className="space-y-0.5">
          {rows.map((r) => (
            <li
              key={r.label}
              className="flex items-center justify-between gap-2 rounded px-1 py-0.5 text-[11px] hover:bg-muted/40"
            >
              <span className="truncate text-muted-foreground">{r.label}</span>
              <span
                className={cn(
                  "shrink-0 tabular-nums",
                  tone === "payout" ? "text-rose-400/90" : "text-foreground/80",
                )}
              >
                {formatCurrency(r.total)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
