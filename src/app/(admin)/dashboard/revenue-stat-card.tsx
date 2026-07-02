"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { ChevronDown, Info, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type {
  GgrBreakdown,
  GgrBreakdownRow,
  GgrTopContributorRow,
} from "@/lib/queries/dashboard";
import { fetchGgrTopContributors } from "./ggr-actions";
import { fetchGgrKpiTopContributors } from "./actions";

/**
 * GGR breakdown popover for the dashboard's GGR KPI box.
 *
 * Originally this module also held the period-aware stat-card tiles (GGR,
 * Wager, Deposits, Withdrawals, PnL). Those were superseded by the unified
 * panel design in `dashboard-kpi-section.tsx` (the today/24h-toggled KPI
 * boxes) and removed; the shared GGR breakdown popover stays here and is
 * imported by that section so the popover isn't duplicated.
 */

/**
 * Popover that shows the GGR formula's components for the selected
 * period: every wager-side ledger type + total, every payout-side
 * ledger type + total, and the math at the bottom (wagersTotal −
 * payoutsTotal = ggr). Auditable line-by-line.
 *
 * Bottom of the popover hosts a "Show top contributors" expander
 * which fires a server action (fetchGgrTopContributors) — kept lazy
 * because the per-user GROUP BY is heavier than the GROUP BY type
 * sweep the rest of the popover uses.
 *
 * Wager rows render with a neutral / muted tint (money flowing IN,
 * not a house gain or loss on its own). Payout rows render rose
 * (money flowing OUT — house loss). Bottom GGR line is colored from
 * the house POV (positive emerald, negative rose) per CLAUDE.md.
 *
 * `contributorScope` picks WHICH lazy contributor action the expander
 * fires so the per-user sweep matches the window the card is showing:
 *   • { kind: "period", value } — the global chip enum ("24h" / "7d" / …),
 *     via `fetchGgrTopContributors`. (Original behaviour.)
 *   • { kind: "kpi", value }    — the per-box today/24h window, via
 *     `fetchGgrKpiTopContributors`.
 * Exported so the reskinned KPI section (today/24h boxes) can reuse the
 * identical popover instead of duplicating ~150 lines.
 */
export type GgrContributorScope =
  | { kind: "period"; value: string }
  | { kind: "kpi"; value: string };

export function GgrBreakdownPopover({
  breakdown,
  periodLabel,
  contributorScope,
  headlineGgr,
  cashGgr,
  deposits,
  withdrawals,
}: {
  breakdown: GgrBreakdown;
  periodLabel: string;
  contributorScope: GgrContributorScope;
  /**
   * The tile's actual headline number — dashboard-local "deposit-funded"
   * GGR (owner request, 2026-07-02; see `dashboard-deposit-funded-ggr.ts`).
   * Shown FIRST so the popover matches the tile. `breakdown.ggr` below is
   * the industry definition (`wager − payouts`) and is now a REFERENCE
   * figure, not the headline — the two can legitimately differ.
   */
  headlineGgr: number;
  /**
   * Cash P&L (`deposits − withdrawals`) for the window. Surfaced as a
   * SECONDARY figure inside the popover so an operator can see net cash
   * kept (crypto-flow tracking) without leaving the tile — NOT the headline
   * number (the tile's headline is deposit-funded GGR).
   */
  cashGgr: number;
  /** Window's deposit dollars — drives the secondary `deposits − withdrawals` math. */
  deposits: number;
  /** Window's withdrawal dollars — drives the secondary `deposits − withdrawals` math. */
  withdrawals: number;
}) {
  const cashIsProfit = cashGgr >= 0;
  const headlineIsProfit = headlineGgr >= 0;
  const ggrIsProfit = breakdown.ggr >= 0;
  // Hide zero-total rows so the list stays readable on quiet windows
  // (e.g. last 1h with no upgrader plays / battles). The headline
  // aggregate at the bottom still reflects the full math.
  const wagers = breakdown.wagers.filter((r) => r.total > 0);
  const payouts = breakdown.payouts.filter((r) => r.total > 0);

  // Contributor expander state — lives in this client component so
  // the server action only runs when the admin actually opens it.
  const [contribState, setContribState] = useState<{
    open: boolean;
    rows: GgrTopContributorRow[] | null;
    error: string | null;
  }>({ open: false, rows: null, error: null });
  const [isPending, startTransition] = useTransition();

  const handleToggleContributors = () => {
    if (contribState.open) {
      setContribState((s) => ({ ...s, open: false }));
      return;
    }
    // First open: fire the action. Subsequent opens reuse the cached
    // rows in state (avoid hammering the DB on every toggle).
    if (contribState.rows) {
      setContribState((s) => ({ ...s, open: true }));
      return;
    }
    startTransition(async () => {
      try {
        const rows =
          contributorScope.kind === "kpi"
            ? await fetchGgrKpiTopContributors(contributorScope.value, 10)
            : await fetchGgrTopContributors(contributorScope.value, 10);
        setContribState({ open: true, rows, error: null });
      } catch (err) {
        setContribState({
          open: true,
          rows: null,
          error:
            err instanceof Error ? err.message : "Failed to load contributors",
        });
      }
    });
  };

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="Show GGR breakdown"
            title="Show GGR breakdown"
            className="rounded text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/40"
          />
        }
      >
        <Info className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-[360px] max-w-[calc(100vw-2rem)] space-y-2 p-3"
      >
        {/* Headline — dashboard-local "deposit-funded" GGR (owner request,
            2026-07-02). Shown FIRST so the popover matches the tile.
            House-POV colour (positive → emerald, negative → rose). */}
        <div>
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              GGR · {periodLabel}
            </p>
            <span
              className={cn(
                "font-bold tabular-nums text-sm",
                headlineIsProfit ? "text-emerald-400" : "text-rose-400",
              )}
            >
              {headlineIsProfit ? "+" : "−"}
              {formatCurrency(Math.abs(headlineGgr))}
            </span>
          </div>
          <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
            Deposit-funded gaming margin — per real customer, traces
            chronologically how much of their wagering in this window was
            fundable by deposits made IN THIS SAME WINDOW (FIFO, never
            replenished by wins); payouts are apportioned to that funded
            share. Excludes wagering funded by balance carried over from a
            prior window.
          </p>
        </div>

        {/* Industry GGR — REFERENCE figure only (wager − payouts on packs,
            battles, upgrader, double down). This is what every other GGR
            surface (`/ggr`, insights, edge-plan) still uses; it is NOT this
            tile's headline. */}
        <div className="border-t border-border/60 pt-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Industry GGR (reference)
          </p>
          <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
            Gross gaming margin (wager − payouts on packs, battles,
            upgrader). Pre-rewards, pre-promo. Wins are valued from
            inventory (the cards kept), not a ledger payout; upgrader
            comes from its own table. Card/voucher conversions are
            neutral and excluded. Real customers only (staff + excluded
            users dropped, all creator play removed, borrow plays removed).
          </p>
        </div>

        {/* Wager-side rows. Section header carries the bucket total so
            the admin can compare buckets at a glance without scrolling
            to the bottom math. Muted-foreground tint — wagers aren't a
            house gain on their own, just flow in. */}
        <BreakdownSection
          title="Wagers"
          total={breakdown.wagersTotal}
          rows={wagers}
          tone="wager"
        />

        {/* Payout-side rows. Rose tint — money flowing OUT of the
            house. The headline number's "negative" component is here. */}
        <BreakdownSection
          title="Payouts"
          total={breakdown.payoutsTotal}
          rows={payouts}
          tone="payout"
        />

        {/* Bottom math: wagersTotal − payoutsTotal = breakdown.ggr — the
            industry REFERENCE figure (not the tile's headline anymore).
            House-POV colour on the final line (positive → emerald,
            negative → rose) per CLAUDE.md. Matches the row totals above
            by construction. */}
        <div className="border-t border-border/60 pt-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold uppercase tracking-wider">
              Industry GGR
            </span>
            <span
              className={cn(
                "font-bold tabular-nums",
                ggrIsProfit ? "text-emerald-400" : "text-rose-400",
              )}
            >
              {ggrIsProfit ? "+" : "−"}
              {formatCurrency(Math.abs(breakdown.ggr))}
            </span>
          </div>
        </div>

        {/* Secondary reference — Cash P&L (`deposits − withdrawals`).
            Net cash kept after withdrawals — useful for crypto-flow
            tracking. NOT the headline (the headline above is the gaming
            margin); shown here so an operator doesn't have to leave the
            popover to see net cash. */}
        <div className="space-y-1 border-t border-border/60 pt-2">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Cash P&L (deposits − withdrawals)
            </p>
            <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
              Net cash kept after withdrawals — for crypto-flow tracking.
              Not gaming margin.
            </p>
          </div>
          <div className="flex items-center justify-between rounded px-1 py-0.5 text-[11px]">
            <span className="text-muted-foreground">Deposits</span>
            <span className="tabular-nums text-emerald-400/90">
              +{formatCurrency(deposits)}
            </span>
          </div>
          <div className="flex items-center justify-between rounded px-1 py-0.5 text-[11px]">
            <span className="text-muted-foreground">Withdrawals</span>
            <span className="tabular-nums text-rose-400/90">
              −{formatCurrency(withdrawals)}
            </span>
          </div>
          <div className="flex items-center justify-between border-t border-border/60 px-1 pt-1.5 text-xs">
            <span className="font-semibold uppercase tracking-wider">
              Cash P&L
            </span>
            <span
              className={cn(
                "font-bold tabular-nums",
                cashIsProfit ? "text-emerald-400" : "text-rose-400",
              )}
            >
              {cashIsProfit ? "+" : "−"}
              {formatCurrency(Math.abs(cashGgr))}
            </span>
          </div>
        </div>

        {/* Contributors expander. Click loads the lazy GROUP BY user_id
            query via a server action and toggles open. A single render
            of the rows is reused on subsequent toggles — no re-fetch
            on close→open within the same popover instance. */}
        <div className="border-t border-border/60 pt-2">
          <button
            type="button"
            onClick={handleToggleContributors}
            disabled={isPending}
            className="flex w-full items-center justify-between rounded-md px-1.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground disabled:opacity-60"
          >
            <span>
              {contribState.open ? "Hide" : "Show"} top 10 contributors
            </span>
            {isPending ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <ChevronDown
                className={cn(
                  "size-3 transition-transform",
                  contribState.open && "rotate-180",
                )}
              />
            )}
          </button>
          {contribState.open && (
            <div className="mt-1.5">
              {contribState.error ? (
                <p className="px-1.5 py-2 text-[10px] text-rose-400">
                  {contribState.error}
                </p>
              ) : contribState.rows && contribState.rows.length > 0 ? (
                <ContributorList rows={contribState.rows} />
              ) : (
                <p className="px-1.5 py-2 text-[10px] text-muted-foreground">
                  No contributing activity in this window.
                </p>
              )}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * One bucket (wagers or payouts) inside the GGR breakdown popover. The
 * section header carries the bucket total + count so admins can scan
 * the popover top-to-bottom without re-summing the per-row figures.
 *
 * `tone` is purely the row-amount colour:
 *   • "wager"  — muted (wagers are flow-in, not a house P&L event on
 *     their own).
 *   • "payout" — rose (every payout shrinks the house P&L).
 * The section header value uses the same tone so the row + total read
 * as one piece.
 */
function BreakdownSection({
  title,
  total,
  rows,
  tone,
}: {
  title: string;
  total: number;
  rows: GgrBreakdownRow[];
  tone: "wager" | "payout";
}) {
  const totalColor =
    tone === "payout" ? "text-rose-400" : "text-foreground";
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
        <span>
          {title}
          {rows.length > 0 && (
            <span className="ml-1 text-muted-foreground/60">
              · {rows.length}
            </span>
          )}
        </span>
        <span className={cn("font-semibold tabular-nums", totalColor)}>
          {tone === "payout" ? "−" : "+"}
          {formatCurrency(total)}
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="px-1 text-[10px] text-muted-foreground/60">
          No activity.
        </p>
      ) : (
        <ul className="space-y-0.5">
          {rows.map((r) => (
            <li
              key={r.type}
              className="flex items-center justify-between gap-2 rounded px-1 py-0.5 text-[11px] hover:bg-muted/40"
            >
              <span className="truncate text-muted-foreground">
                {r.type}
              </span>
              <span
                className={cn(
                  "shrink-0 tabular-nums",
                  tone === "payout"
                    ? "text-rose-400/90"
                    : "text-foreground/80",
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

/**
 * Top contributors expander content. Each row links to /users/<id>,
 * shows username + wager/payout pair + net contribution. Net is
 * coloured house-POV per CLAUDE.md:
 *   • net > 0 → user lost (we profited) → emerald
 *   • net < 0 → user won (we lost) → rose
 *   • net = 0 → muted (rare; could happen on pure-wager sessions
 *     with no payouts in the window).
 */
function ContributorList({ rows }: { rows: GgrTopContributorRow[] }) {
  return (
    <ul className="space-y-0.5">
      {rows.map((r, idx) => {
        const isHouseProfit = r.net > 0;
        const isHouseLoss = r.net < 0;
        const username = r.username ?? `${r.userId.slice(0, 6)}…`;
        return (
          <li key={r.userId}>
            <Link
              href={`/users/${r.userId}`}
              className="flex items-center justify-between gap-2 rounded px-1 py-1 text-[11px] transition-colors hover:bg-muted/60"
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="w-4 shrink-0 text-right text-muted-foreground/60 tabular-nums">
                  {idx + 1}.
                </span>
                <span className="truncate font-medium">{username}</span>
              </span>
              <span className="flex shrink-0 items-center gap-2 tabular-nums">
                {/* W / P → wager / payout for the window. Headline GGR is
                    `wager − payouts` (industry), so the per-user
                    contributor sweep ranks users by the gaming margin
                    they contributed (positive → house gain, user lost).
                    The two legs are surfaced here for audit so an admin
                    can see why a user lands on the list. */}
                <span className="text-muted-foreground/60">
                  W {formatNumber(Math.round(r.wagerTotal))} ·{" "}
                  P {formatNumber(Math.round(r.payoutTotal))}
                </span>
                <span
                  className={cn(
                    "min-w-[64px] text-right font-semibold",
                    isHouseProfit
                      ? "text-emerald-400"
                      : isHouseLoss
                        ? "text-rose-400"
                        : "text-muted-foreground/60",
                  )}
                >
                  {isHouseProfit ? "+" : isHouseLoss ? "−" : ""}
                  {formatCurrency(Math.abs(r.net))}
                </span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
