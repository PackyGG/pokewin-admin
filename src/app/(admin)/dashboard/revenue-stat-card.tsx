"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChevronDown, Info, Loader2, TrendingUp, TrendingDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { AnimatedNumber } from "@/components/animated-number";
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
import { getLifetimePnlAction } from "./actions";

/**
 * Period-aware stat cards used in the dashboard's primary KPI strip.
 *
 * As of the global-period-selector refactor these cards no longer carry
 * their own chip rows — the dashboard now has a single
 * `<DashboardPeriodSelector>` at the top of the page that drives a
 * `?period=` URL param, and the server computes only the selected
 * period's value. Each card receives the resolved scalar value plus a
 * `periodLabel` (e.g. "Last 24h") so the title strip explains what the
 * dollar number is scoped to.
 *
 * House-POV color rules per CLAUDE.md:
 *   • House profit (positive PnL / positive GGR / positive Edge) →
 *     emerald
 *   • House loss (negative)                                       → rose
 *   • Identity-only colors (Wager, Deposits, Withdrawals) are picked
 *     for visual distinction in the row — they don't carry house-POV
 *     semantics on their own.
 */

// House P&L with two modes behind a small toggle:
//   • period   — the ROLLING windowed delta for the SELECTED period
//     (was 24h-only before the global selector): the change in house
//     P&L over the chosen window. This is the DEFAULT view — it comes
//     for free from periodAggregates + windowedPeriodDelta (already
//     computed for other tiles), so the dashboard never pays for the
//     heavy lifetime scan on a cold load.
//   • lifetime — the realized-P&L SNAPSHOT (getRealizedPnlSnapshot):
//     deposits − withdrawals − user balances − inventory − unclaimed
//     vouchers − unclaimed rakeback, valued right now. Not a time series,
//     and the single heaviest query in the codebase — so it loads LAZILY
//     via the getLifetimePnlAction server action only when the admin
//     clicks the "lifetime" toggle. The fetched value is cached in client
//     state so re-clicks are instant; a small inline spinner shows while
//     the first fetch is in flight. Different methodology from the
//     snapshot (no rakeback term), so it sits behind its own toggle
//     rather than pretending the snapshot is a time series.
//
// Colors follow CLAUDE.md's house-POV rule: house profit = emerald,
// house loss = rose. The card tint + value color flip with the SELECTED
// value, so switching to the lifetime view recolors the card if the
// lifetime P&L is a loss.
export function PnlStatCard({
  pnl,
  pnlPeriod,
  periodLabel,
}: {
  // Lifetime realized P&L. OPTIONAL + lazy: the dashboard no longer
  // computes this eagerly (it's the heaviest query in the codebase), so
  // it usually arrives as undefined and is fetched on demand the first
  // time the admin opens the "lifetime" view (see getLifetimePnlAction).
  // A caller MAY still pass a precomputed value (then no fetch happens).
  pnl?: number | null;
  pnlPeriod: number;
  // Friendly label for the period (e.g. "Last 24h", "Last 7 days").
  // Drives the toggle label so it reads as "24h / lifetime" or
  // "7d / lifetime" depending on the global selector.
  periodLabel: string;
}) {
  // Default to the cheap PERIOD view (Part 2a) so a cold dashboard load
  // never triggers the lifetime scan.
  const [mode, setMode] = useState<"lifetime" | "period">("period");
  // Lazily-loaded lifetime value. Seeded from the optional `pnl` prop if
  // a caller passed one, else null until the first "lifetime" click
  // fetches it. Cached here so re-clicks are instant (no re-fetch).
  const [lifetimePnl, setLifetimePnl] = useState<number | null>(
    pnl ?? null,
  );
  const [lifetimeLoading, setLifetimeLoading] = useState(false);
  const [, startTransition] = useTransition();

  const handleSelect = (next: "lifetime" | "period") => {
    setMode(next);
    // Fetch the lifetime snapshot on the first switch to "lifetime" when
    // we don't already have it. Subsequent switches reuse client state.
    if (
      next === "lifetime" &&
      lifetimePnl === null &&
      !lifetimeLoading
    ) {
      setLifetimeLoading(true);
      startTransition(async () => {
        try {
          const v = await getLifetimePnlAction();
          setLifetimePnl(v);
        } catch (err) {
          toast.error(
            err instanceof Error ? err.message : "Failed to load lifetime P&L",
          );
        } finally {
          setLifetimeLoading(false);
        }
      });
    }
  };

  // The value shown depends on the active mode. In lifetime mode we show
  // the loaded snapshot (or a spinner while it loads / nothing yet).
  const showLifetimeSpinner =
    mode === "lifetime" && lifetimePnl === null && lifetimeLoading;
  const value = mode === "lifetime" ? lifetimePnl : pnlPeriod;
  // Card tint follows the value when one is present; while the lifetime
  // value is still loading, fall back to a neutral emerald tint rather
  // than flashing rose for an unknown sign.
  const isProfit = value === null ? true : value >= 0;

  return (
    <Card className={cn(isProfit ? "bg-emerald-500/10" : "bg-rose-500/10")}>
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <CardTitle className="text-card-title text-muted-foreground">
            PnL
          </CardTitle>
          <div className="flex gap-0.5">
            {([
              { key: "period" as const, label: periodLabel },
              { key: "lifetime" as const, label: "lifetime" },
            ]).map((m) => (
              <button
                key={m.key}
                onClick={() => handleSelect(m.key)}
                className={cn(
                  "rounded px-1.5 py-0.5 text-tiny font-medium transition-colors",
                  mode === m.key
                    ? "bg-background/70 text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
        {isProfit ? (
          <TrendingUp className="size-4 shrink-0 text-emerald-400" />
        ) : (
          <TrendingDown className="size-4 shrink-0 text-rose-400" />
        )}
      </CardHeader>
      <CardContent>
        <div className="text-stat-value truncate">
          {showLifetimeSpinner ? (
            <span className="inline-flex items-center gap-2 text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
              <span className="text-base font-normal">Loading…</span>
            </span>
          ) : value === null ? (
            // mode === "lifetime" but no value yet and not loading (e.g.
            // a prior fetch errored). Show a muted dash; clicking the
            // toggle again retries the fetch.
            <span className="text-muted-foreground">—</span>
          ) : (
            <span className={isProfit ? "text-emerald-400" : "text-rose-400"}>
              {isProfit ? "+" : ""}
              <AnimatedNumber value={value} format="currency" />
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// Gaming margin (GGR = wagers − payouts) for the selected period. Keeps
// emerald/rose for sign so direction is readable at a glance. Card
// identity colour is cyan so it's visually distinct from the rest of
// the row.
//
// A GGR → P&L reconciliation popover was attempted in 8e1e835 (round 5
// of GGR work) but the bridge it surfaced — `P&L ≈ GGR − inventoryΔ −
// voucherΔ` — is not a true accounting identity. Substituting the
// ledger balance-change definition into the P&L formula leaves missing
// terms for card withdrawals AND every non-GGR-typed credit (rain,
// rakeback, gifts, creator tips, race prizes, bonuses, etc.), so the
// residual is structurally large — at the time of revert the popover
// showed a $92k residual on a $4.6k "P&L" line. An honest "no
// reconciliation" beats a wrong one.
//
// Round 6: instead of bridging GGR to P&L (which conflates two
// independent formulas), the popover shows the GGR formula's LEGS for
// the window — the wager leg (pack/battle + upgrader stake) and the
// payout leg (pack/battle wins valued from inventory + battle refunds +
// upgrader payout), per the canonical @/lib/metrics inventory-delta
// definition. Bottom of the popover offers a "Show top contributors"
// expander that fires a server action computing the SAME per-user net,
// so the admin can drill from "GGR = -$102k" → which users drove it.
// Pure transparency, no derivations. (NOTE: card/voucher conversions and
// reward giveaways are NOT on the payout leg — they're neutral /
// NGR-side. Upgrader IS included now — it's folded into the canonical
// GGR from `upgrader_games`, shown as its own wager + payout rows; the
// dedicated Upgrader Stats panel still breaks it down with
// wins/losses/hit-rate.)
export function GgrStatCard({
  ggr,
  periodLabel,
  // Period+blacklist-cached per-type breakdown sourced from
  // getGgrBreakdown. Optional so the card still renders if a caller
  // (e.g. a tests / storybook surface) skips it — but `breakdown.ggr`
  // is always preferred over the headline `ggr` prop when present so
  // the popover's bottom row matches the row totals exactly (defends
  // against any rounding drift between the headline aggregate and the
  // GROUP BY type sweep, even though they read from the same SQL).
  breakdown,
  // Sanitized period string ("24h" / "7d" / ...) — passed to the
  // server action that loads the lazy contributor list, so the action
  // computes the per-user sweep against the SAME window the admin is
  // currently looking at.
  periodParam,
}: {
  ggr: number;
  periodLabel: string;
  breakdown?: GgrBreakdown;
  periodParam: string;
}) {
  const isProfit = ggr >= 0;
  return (
    <Card className="bg-cyan-500/10">
      <CardHeader className="flex flex-col gap-2 pb-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <CardTitle className="text-card-title text-muted-foreground inline-flex items-center gap-1">
            GGR
            {breakdown && (
              <GgrBreakdownPopover
                breakdown={breakdown}
                periodLabel={periodLabel}
                periodParam={periodParam}
              />
            )}
          </CardTitle>
          <span className="text-tiny text-muted-foreground">{periodLabel}</span>
        </div>
        {isProfit ? (
          <TrendingUp className="size-4 shrink-0 text-emerald-400" />
        ) : (
          <TrendingDown className="size-4 shrink-0 text-rose-400" />
        )}
      </CardHeader>
      <CardContent>
        <div className="text-stat-value truncate">
          <span className={isProfit ? "text-emerald-400" : "text-rose-400"}>
            {isProfit ? "+" : ""}
            <AnimatedNumber value={ggr} format="currency" />
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

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
 */
function GgrBreakdownPopover({
  breakdown,
  periodLabel,
  periodParam,
}: {
  breakdown: GgrBreakdown;
  periodLabel: string;
  periodParam: string;
}) {
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
        const rows = await fetchGgrTopContributors(periodParam, 10);
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
        className="w-[340px] max-w-[calc(100vw-2rem)] space-y-2 p-3"
      >
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            GGR breakdown
          </p>
          <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
            {periodLabel}. GGR = wager − (pack/battle wins + battle
            refunds + upgrader payout). Wins are valued from inventory
            (the cards kept), not a ledger payout; upgrader comes from
            its own table. Card/voucher conversions are neutral and
            excluded. Real customers only (staff + excluded users dropped,
            all creator play removed, borrow plays removed) — so
            this matches the headline.
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

        {/* Bottom math: wagersTotal − payoutsTotal = ggr. House-POV
            colour on the final line (positive → emerald, negative →
            rose) per CLAUDE.md. The breakdown's ggr is used directly
            (not the headline `ggr` prop) so this number matches the
            row totals above by construction. */}
        <div className="border-t border-border/60 pt-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold uppercase tracking-wider">
              GGR
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

// Wagers = money the user sent into the house treasury for a bet.
// Always positive, so we give it a purple identity color to differentiate
// from the other period cards (Deposits / GGR / PnL / Withdrawals).
//
// Reused for three cards on the dashboard: "Total Wager" (customer
// wager — wagers a creator made while live on a deal/stream are
// dropped, since that is house-funded "sponsored" balance), "Raw
// Wager" (includes them) and "Organic Wager" (no creator-code users).
// `caption` carries the muted hint that distinguishes them.
//
// `breakdown` (optional) drives the small Packs / Battles / Upgrader
// chip row at the bottom of the card. Only the "Total Wager" instance
// passes it today — the Raw / Organic variants skip the chips.
export function WagerStatCard({
  wager,
  periodLabel,
  title = "Total Wager",
  caption,
  breakdown,
}: {
  wager: number;
  periodLabel: string;
  title?: string;
  caption?: string;
  breakdown?: {
    packs: number;
    battles: number;
    upgrader: number;
  };
}) {
  return (
    <Card className="bg-purple-500/10">
      <CardHeader className="flex flex-col gap-2 pb-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <CardTitle className="text-card-title text-muted-foreground">
            {title}
          </CardTitle>
          <span className="text-tiny text-muted-foreground">
            {periodLabel}
            {caption ? ` · ${caption}` : ""}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-stat-value truncate">
          <AnimatedNumber value={wager} format="currency" />
        </div>
        {breakdown && (
          // 3 chip-style mini-boxes — Packs · Battles · Upgrader — for
          // the SELECTED window. Each chip carries its own label and a
          // small dollar amount so admins can see at a glance where the
          // window's wager volume comes from.
          <div className="grid grid-cols-3 gap-1.5 -mx-0.5">
            <WagerSourceChip label="Packs" value={breakdown.packs} />
            <WagerSourceChip label="Battles" value={breakdown.battles} />
            <WagerSourceChip label="Upgrader" value={breakdown.upgrader} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Small chip showing one of the wager sources (Packs / Battles /
 * Upgrader) under the Total Wager card. Compact: a tiny uppercase
 * label and a dollar value, sized so 3 chips fit on a phone-width
 * card. Uses the same purple identity color as the parent card with a
 * weaker fill so the chips read as a "secondary" row.
 */
function WagerSourceChip({
  label,
  value,
}: {
  label: string;
  value: number;
}) {
  return (
    <div className="rounded-md border border-purple-500/15 bg-background/40 px-2 py-1.5 min-w-0">
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground truncate">
        {label}
      </p>
      <p className="text-xs font-semibold tabular-nums truncate">
        <AnimatedNumber value={value} format="currency" />
      </p>
    </div>
  );
}

// Deposits = fresh cash flowing into the house. House gain → emerald.
// Shows two stacked signals tied to the global period:
//   1) total deposit amount in USD (the primary hero number)
//   2) deposit count + avg deposit size for the SELECTED period —
//      `Y deposits · ~$Z avg`. Avg is derived inline from
//      `deposits / depositCount` (defends against divide-by-zero with
//      "—") so admins can read at a glance whether the window's volume
//      came from many small deposits or fewer large ones, scoped to
//      whichever chip is selected.
export function DepositsStatCard({
  deposits,
  depositCount,
  periodLabel,
}: {
  deposits: number;
  // Optional so call sites that just want the dollar figure can skip
  // the secondary line.
  depositCount?: number;
  periodLabel: string;
}) {
  // Period-aware average deposit size. Falls back to "—" on a zero-
  // count window so we never render "$NaN" or "$0 avg" misleadingly.
  const avgDeposit =
    typeof depositCount === "number" && depositCount > 0
      ? formatCurrency(deposits / depositCount)
      : "—";
  return (
    <Card className="bg-emerald-500/10">
      <CardHeader className="flex flex-col gap-2 pb-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <CardTitle className="text-card-title text-muted-foreground">
            Deposits
            {typeof depositCount === "number" && (
              // Inline transaction-count chip next to the title — keeps
              // the count visible even when the user scrolls past the
              // sub-line. Muted so it doesn't compete with the dollar
              // hero value. formatNumber gives "1,234" for big windows.
              <span className="ml-1 text-xs font-normal text-muted-foreground tabular-nums">
                · {formatNumber(depositCount)}
              </span>
            )}
          </CardTitle>
          <span className="text-tiny text-muted-foreground">{periodLabel}</span>
        </div>
      </CardHeader>
      <CardContent>
        <div className="text-stat-value truncate">
          <AnimatedNumber value={deposits} format="currency" />
        </div>
        {typeof depositCount === "number" && (
          <p className="text-stat-label mt-0.5">
            <AnimatedNumber value={depositCount} format="number" />{" "}
            {depositCount === 1 ? "deposit" : "deposits"} · ~{avgDeposit} avg
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// Crypto + card withdrawals totalled for the selected period. Uses a
// pink identity so it's visually distinct from the PnL card (which uses
// rose when negative). The semantic is still "money leaving the house"
// but the card color is purely an identity signal.
export function WithdrawalsStatCard({
  withdrawals,
  withdrawalCount,
  periodLabel,
}: {
  withdrawals: number;
  // Optional so callers that just want the dollar figure can skip the
  // title chip. Sourced from the same `withdrawals` CTE as the dollar
  // amount in `getDashboardStats`, so they always match.
  withdrawalCount?: number;
  periodLabel: string;
}) {
  return (
    <Card className="bg-pink-500/10">
      <CardHeader className="flex flex-col gap-2 pb-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <CardTitle className="text-card-title text-muted-foreground">
            Withdrawals
            {typeof withdrawalCount === "number" && (
              // Inline transaction-count chip — matches the Deposits
              // card so admins can compare flow counts at a glance
              // without reading the dollar amounts.
              <span className="ml-1 text-xs font-normal text-muted-foreground tabular-nums">
                · {formatNumber(withdrawalCount)}
              </span>
            )}
          </CardTitle>
          <span className="text-tiny text-muted-foreground">{periodLabel}</span>
        </div>
      </CardHeader>
      <CardContent>
        <div className="text-stat-value truncate">
          <AnimatedNumber value={withdrawals} format="currency" />
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Creator DEAL-PAYOUT cash-outs for the period — the dollar value of
 * creator deal-payout vouchers that have actually left the house via a
 * completed/shipped withdrawal request, plus the count of such requests.
 *
 * SCOPE: sums `vouchers.value` for the two creator deal-payout voucher
 * origins — `creator_fill_conversion` (the weekly-fill end-of-session
 * payout) and `creator_multiplier_payout` (the multiplier-deal settled
 * payout) — joined to the completed/shipped `card_withdrawal_requests`
 * they were cashed out in. This is a REAL house creator cost: deal payouts
 * the house funded that the creator has actually withdrawn. It is NOT a
 * creator's personal balance cash-out (their own deposited money), which
 * the previous version of this tile counted.
 *
 * The dollar VALUE is the hero (it's a cost figure now), with the count
 * of distinct withdrawal requests on the sub-line + the period label.
 *
 * House POV (per CLAUDE.md): paying a creator out = house outflow → rose.
 */
export function CreatorWithdrawalsStatCard({
  count,
  amount,
  periodLabel,
}: {
  count: number;
  amount: number;
  periodLabel: string;
}) {
  return (
    <Card className="bg-rose-500/10">
      <CardHeader className="flex flex-col gap-2 pb-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <CardTitle className="text-card-title text-muted-foreground inline-flex items-center gap-1">
            Creator Deal Payouts (withdrawn)
            <Popover>
              <PopoverTrigger
                render={
                  <button
                    type="button"
                    aria-label="What this counts"
                    title="What this counts"
                    className="rounded text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/40"
                  />
                }
              >
                <Info className="size-3.5" />
              </PopoverTrigger>
              <PopoverContent
                align="start"
                sideOffset={6}
                className="w-[320px] max-w-[calc(100vw-2rem)] p-3 text-[11px] leading-snug text-muted-foreground"
              >
                <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-foreground">
                  Creator deal payouts (withdrawn)
                </p>
                <p>
                  Dollar value of creator <strong>deal-payout vouchers</strong>{" "}
                  (<code className="font-mono">creator_fill_conversion</code> +{" "}
                  <code className="font-mono">creator_multiplier_payout</code>)
                  that have left the house via a completed/shipped withdrawal
                  request — deal money the house funded that the creator
                  actually cashed out.
                </p>
                <p className="mt-1.5">
                  This is a real <strong>house creator cost</strong>, not a
                  creator&apos;s personal balance cash-out (their own deposited
                  money). The count is the number of withdrawal requests that
                  cashed out at least one deal-payout voucher in this period.
                </p>
              </PopoverContent>
            </Popover>
          </CardTitle>
          <span className="text-tiny text-muted-foreground">{periodLabel}</span>
        </div>
      </CardHeader>
      <CardContent>
        <div className="text-stat-value truncate text-rose-400">
          <AnimatedNumber value={amount} format="currency" />
        </div>
        <p className="text-stat-label mt-0.5">
          <AnimatedNumber value={count} format="number" />{" "}
          {count === 1 ? "withdrawal" : "withdrawals"} · deal payouts cashed out
        </p>
      </CardContent>
    </Card>
  );
}
