"use client";

import {
  Info,
  TrendingUp,
  TrendingDown,
  ArrowDownToLine,
  ArrowUpFromLine,
  Wallet,
  Box,
  Ticket,
  type LucideIcon,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { AnimatedNumber } from "@/components/animated-number";
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { houseAmountTextClass } from "@/lib/house-pov";
import { TodayNetHoldingsHoldersChip } from "./today-net-holdings-holders";
import { GgrBreakdownPopover } from "./revenue-stat-card";
import type { GgrBreakdown } from "@/lib/queries/dashboard";

/**
 * "P&L Today" dashboard tile — house P&L for the CURRENT CALENDAR DAY
 * since 00:00 (NOT a rolling past-24h window).
 *
 * The number is the canonical windowed-delta P&L over [today 00:00 UTC,
 * now): deposits − withdrawals − balanceΔ − inventoryΔ − voucherΔ (see
 * getTodayPnl / calculateWindowedPnl). Because it's the same formula the
 * period-P&L card and daily-P&L chart use, this reconciles with them.
 *
 * House-POV colors per CLAUDE.md (flat surface — the profit/loss signal
 * lives on the value + trend icon, not a colored card fill):
 *   • P&L ≥ 0 → house in profit → emerald (value + trend icon).
 *   • P&L < 0 → house in the red → rose.
 * The card face also shows the two largest plain components — Deposits
 * (emerald, capital in) and Withdrawals (rose, money out) — matching the
 * shape of the daily P&L card the operator referenced. The Info popover
 * (styled exactly like the GGR breakdown button) spells out every
 * component with its signed contribution to house P&L.
 *
 * The tile also carries an optional GGR section at the BOTTOM (owner
 * request, 2026-07-02: "the P&L today window is 50% empty now — fill it
 * with GGR, GGR at bottom and P&L stuff at top"), reusing the exact
 * `getDashboardKpiStats("today")` payload the KPI strip's GGR box used to
 * render (that box was removed from the strip) and the SAME
 * `GgrBreakdownPopover` for the info breakdown, so the figure and its
 * popover are byte-identical to what the strip used to show — just
 * relocated. `ggr` is optional/nullable so a failed GGR fetch degrades to
 * omitting that section instead of taking the whole P&L tile down.
 *
 * All props are serializable primitives — no function props cross the RSC
 * boundary (AnimatedNumber takes the `format` string-enum, not a
 * formatter fn) per CLAUDE.md / Next 15.
 */
/**
 * GGR section payload — identical shape to the fields the KPI strip's old
 * GGR box read off `KpiWindowPayload` for the "today" window. Kept as its
 * own small type here (rather than importing `KpiWindowPayload` wholesale)
 * since this card only needs the GGR-specific slice, not the wager/cashflow
 * fields the strip also carries.
 */
export type TodayGgrPayload = {
  /** Canonical industry GGR (wagers − gaming payouts) for today. */
  value: number;
  /** Net cash flow (deposits − withdrawals) — secondary popover figure. */
  netCashFlow: number;
  /** Window's deposit/withdrawal dollars — drive the cash-flow math. */
  deposits: number;
  withdrawals: number;
  /** Industry-GGR breakdown legs for the popover. */
  breakdown: GgrBreakdown;
};

export function TodayPnlStatCard({
  pnl,
  deposits,
  withdrawals,
  balanceChange,
  inventoryChange,
  voucherChange,
  /** YYYY-MM-DD (UTC) — the calendar day this P&L covers. */
  dayLabel,
  ggr,
}: {
  pnl: number;
  deposits: number;
  withdrawals: number;
  balanceChange: number;
  inventoryChange: number;
  voucherChange: number;
  dayLabel: string;
  /** Bottom-of-tile GGR section payload — omitted (null) on a failed fetch. */
  ggr?: TodayGgrPayload | null;
}) {
  const isProfit = pnl >= 0;
  const rawCashPnl = deposits - withdrawals;
  const rawCashUp = rawCashPnl > 0;
  const rawCashDown = rawCashPnl < 0;
  // Net change in user holdings (balance + inventory + vouchers). When
  // negative, user liabilities shrank — partially offsets deposits vs
  // withdrawals on the headline P&L figure.
  const netHoldingsChange = balanceChange + inventoryChange + voucherChange;
  const netHoldingsPnlContribution = -netHoldingsChange;
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
          <CardTitle className="text-card-title text-muted-foreground inline-flex items-center gap-1">
            Balance-sheet P&amp;L Today
            <TodayPnlInfoPopover
              isProfit={isProfit}
              pnl={pnl}
              deposits={deposits}
              withdrawals={withdrawals}
              balanceChange={balanceChange}
              inventoryChange={inventoryChange}
              voucherChange={voucherChange}
              dayLabel={dayLabel}
            />
          </CardTitle>
          {/* Calendar date the figure covers — anchors the "since 00:00
              today" semantic visually (matches the referenced daily P&L
              card's date header). */}
          <span className="text-tiny text-muted-foreground tabular-nums">
            {dayLabel}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <RawCashPnlBadge pnl={rawCashPnl} />
          {isProfit ? (
            <TrendingUp className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
          ) : (
            <TrendingDown className="size-4 shrink-0 text-rose-600 dark:text-rose-400" />
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-stat-value truncate">
          <span className={houseAmountTextClass(pnl)}>
            {isProfit ? "+" : "−"}
            <AnimatedNumber value={Math.abs(pnl)} format="currency" />
          </span>
        </div>
        {/* Deposits / Withdrawals / user holdings — net cash flow alone does
            not equal balance-sheet P&L; the third chip explains the gap. */}
        <div className="grid grid-cols-2 gap-1.5 -mx-0.5">
          <TodayComponentChip
            label="Deposits"
            value={deposits}
            tone="emerald"
          />
          <TodayComponentChip
            label="Withdrawals"
            value={withdrawals}
            tone="rose"
          />
          <TodayNetHoldingsHoldersChip
            netHoldingsChange={netHoldingsChange}
            tone={netHoldingsPnlContribution >= 0 ? "emerald" : "rose"}
            hint={
              netHoldingsChange === 0
                ? "No net change in user balance, inventory, or vouchers"
                : netHoldingsChange < 0
                  ? "User holdings fell — helps house P&L vs cash flow alone"
                  : "User holdings grew — drags house P&L vs cash flow alone"
            }
            className="col-span-2"
          />
        </div>
        {/* Bumped 10px → 11px — the prior 10px caption was effectively
            illegible on the dark theme even after the muted-foreground
            bump; 11px keeps the secondary rank vs the chip values
            above without being a smudge. */}
        <p className="text-[11px] leading-snug text-muted-foreground">
          Balance-sheet P&amp;L = net cash flow − change in user holdings. See
          the <span className="font-medium text-foreground/80">info</span>{" "}
          icon. Top-right{" "}
          <span
            className={cn(
              "font-medium",
              rawCashUp && "text-emerald-600 dark:text-emerald-400",
              rawCashDown && "text-rose-600 dark:text-rose-400",
              !rawCashUp && !rawCashDown && "text-foreground/80",
            )}
          >
            net cash flow
          </span>{" "}
          is deposits − withdrawals. GGR below is wagers − gaming payouts;
          deposits that remain in user holdings are not gaming revenue.
        </p>
        {/* GGR — moved down here from the KPI strip (owner request,
            2026-07-02) so the P&L Today tile fills the space the strip's
            other boxes reclaimed once they grew their full data sets back.
            Same canonical GGR headline + the same `GgrBreakdownPopover` the
            strip used, scoped to "today" (this
            tile never toggles to 24h). Omitted entirely when the fetch
            failed (`ggr` is null) rather than showing a broken section. */}
        {ggr && <TodayGgrSection ggr={ggr} />}
      </CardContent>
    </Card>
  );
}

/**
 * Bottom-of-tile GGR block — mirrors the KPI strip's former GGR box body
 * (title + Info popover + house-POV trend icon, hero value, subtitle) inside
 * a compact section instead of a full standalone `KpiPanel`, separated from
 * the P&L content above by a hairline divider (same pattern the merged
 * Reward+Creators / Upgrader+DoubleDown tiles use between their halves).
 */
function TodayGgrSection({ ggr }: { ggr: TodayGgrPayload }) {
  const isProfit = ggr.value >= 0;
  return (
    <div className="border-t border-border/50 pt-3">
      <div className="flex items-center justify-between gap-2">
        <p className="flex min-w-0 items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-cyan-600 dark:text-cyan-400">
          <span className="truncate">GGR</span>
          <GgrBreakdownPopover
            breakdown={ggr.breakdown}
            periodLabel="Today"
            contributorScope={{ kind: "kpi", value: "today" }}
            headlineGgr={ggr.value}
            netCashFlow={ggr.netCashFlow}
            deposits={ggr.deposits}
            withdrawals={ggr.withdrawals}
          />
        </p>
        {isProfit ? (
          <TrendingUp className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
        ) : (
          <TrendingDown className="size-4 shrink-0 text-rose-600 dark:text-rose-400" />
        )}
      </div>
      <div className="truncate text-lg font-bold tabular-nums sm:text-xl">
        <span className={houseAmountTextClass(ggr.value)}>
          {isProfit ? "+" : "−"}
          <AnimatedNumber value={Math.abs(ggr.value)} format="currency" />
        </span>
      </div>
      <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
        wagers − gaming payouts today. This is realized gaming margin, not
        deposits − withdrawals.
      </p>
    </div>
  );
}

/**
 * Top-right badge: raw cash flow today — deposits minus withdrawals only,
 * with no balance / inventory / voucher terms. House-POV colors match the
 * headline P&L tile and the Creators Costs affiliate-PnL corner badge.
 */
function RawCashPnlBadge({ pnl }: { pnl: number }) {
  const up = pnl > 0;
  const down = pnl < 0;
  const sign = up ? "+" : down ? "−" : "";
  return (
    <span
      title={`Raw cash flow today (since 00:00 UTC): completed fiat + crypto deposits minus card + manual withdrawals. Paid-but-uncredited payment attempts are excluded. No balance, inventory, or voucher movement.`}
      // Bumped 10px → 11px to match the rest of the card's
      // post-readability-pass labels — the badge sits next to the
      // hero number, so the prior 10px text was lost beside it.
      className={cn(
        "inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-semibold tabular-nums leading-none",
        up &&
          "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
        down &&
          "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400",
        !up &&
          !down &&
          "border-border/60 bg-background/40 text-muted-foreground",
      )}
    >
      <span className="mr-px text-muted-foreground/80">Net cash flow</span>
      <span className="ml-1">
        {sign}
        <AnimatedNumber value={Math.abs(pnl)} format="currency" />
      </span>
    </span>
  );
}

/**
 * Small chip showing one headline component (Deposits / Withdrawals) on
 * the card face. Tone is the identity color for the flow direction from
 * the house POV: deposits = emerald (capital in), withdrawals = rose
 * (money out). Mirrors the WagerSourceChip used on the Wager card.
 */
function TodayComponentChip({
  label,
  value,
  tone,
  hint,
  className,
}: {
  label: string;
  value: number;
  tone: "emerald" | "rose";
  hint?: string;
  className?: string;
}) {
  const border =
    tone === "emerald" ? "border-emerald-500/15" : "border-rose-500/15";
  const valueColor =
    tone === "emerald"
      ? "text-emerald-600 dark:text-emerald-400"
      : "text-rose-600 dark:text-rose-400";
  return (
    <div
      className={cn(
        "rounded-md border bg-background/40 px-2 py-1.5 min-w-0",
        border,
        className,
      )}
      title={hint}
    >
      {/* Label bumped 10px → 11px, value bumped text-xs → text-[13px]
          to match the dashboard's PanelChip — keeps both component
          chips visually identical so the eye doesn't try to assign
          different meaning to a 1-pixel size delta. */}
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground truncate">
        {label}
      </p>
      <p className={cn("text-[13px] font-semibold tabular-nums truncate", valueColor)}>
        <AnimatedNumber value={value} format="currency" />
      </p>
    </div>
  );
}

/**
 * Info popover styled exactly like the GGR breakdown button (Popover +
 * render-prop trigger + Info icon + small PopoverContent). Lists every
 * P&L component with its SIGNED contribution to house P&L and the math at
 * the bottom (the five contributions sum to the total). Each amount is
 * colored House-POV: a positive contribution (house gained / a liability
 * shrank) is emerald, a negative one (house paid / a liability grew) is
 * rose — same convention as the analytics Period-P&L breakdown.
 */
function TodayPnlInfoPopover({
  isProfit,
  pnl,
  deposits,
  withdrawals,
  balanceChange,
  inventoryChange,
  voucherChange,
  dayLabel,
}: {
  isProfit: boolean;
  pnl: number;
  deposits: number;
  withdrawals: number;
  balanceChange: number;
  inventoryChange: number;
  voucherChange: number;
  dayLabel: string;
}) {
  const withdrawalsContribution = -withdrawals;
  const rows: Array<{
    id: "deposits" | "withdrawals" | "balance" | "inventory" | "voucher";
    label: string;
    description: string;
    contribution: number;
    icon: LucideIcon;
  }> = [
    {
      id: "deposits",
      label: "Deposits",
      description: "Completed real-money deposits credited today",
      contribution: deposits,
      icon: ArrowDownToLine,
    },
    {
      id: "withdrawals",
      label: "Withdrawals",
      description: "Card withdrawals shipped/completed + manual today",
      contribution: withdrawalsContribution,
      icon: ArrowUpFromLine,
    },
    {
      id: "balance",
      label: "User Balance change",
      description: "Net change in user available + locked balance",
      contribution: -balanceChange,
      icon: Wallet,
    },
    {
      id: "inventory",
      label: "Inventory change",
      description:
        "Cards obtained minus sold/exchanged/admin-removed today",
      contribution: -inventoryChange,
      icon: Box,
    },
    {
      id: "voucher",
      label: "Voucher change",
      description: "Vouchers issued minus claimed/admin-removed today",
      contribution: -voucherChange,
      icon: Ticket,
    },
  ];

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="Show today's P&L breakdown"
            title="Show today's P&L breakdown"
            className="rounded text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40"
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
            P&amp;L today · breakdown
          </p>
          {/* Bumped 10px → 11px so the popover description is readable
              alongside the breakdown rows below it. */}
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
            Since 00:00 today (UTC) — <strong>{dayLabel}</strong> — not a
            rolling 24h window. House P&amp;L ={" "}
            <span className="font-mono">
              deposits − withdrawals − balance change − inventory change −
              voucher change
            </span>{" "}
            over the day. This is <strong>balance-sheet movement</strong>, not
            GGR or gaming margin — the same formula as the period-P&amp;L card
            and the daily-P&amp;L chart. Real customers only (staff + excluded
            users dropped).{" "}
            <strong>Net cash flow</strong> (top-right badge) is deposits −
            withdrawals only — completed fiat + crypto cash flow with no
            balance / inventory / voucher terms. Paid-but-uncredited payment
            attempts are excluded.{" "}
            <strong>Includes:</strong> gaming, rakeback, bonuses, card sales,
            fraud/abuse cash removals, admin inventory/voucher removals
            (via sold/claimed stamps).{" "}
            <strong>Excludes:</strong> official_stream fake balance and
            remove_locked_balance vault moves (netted out of balance change).
          </p>
        </div>

        {/* Component rows — each shows its SIGNED contribution to house
            P&L, House-POV colored (positive emerald, negative rose). */}
        <ul className="space-y-0.5">
          {rows.map((r) => (
            <TodayBreakdownRow
              key={r.id}
              label={r.label}
              description={r.description}
              contribution={r.contribution}
              icon={r.icon}
            />
          ))}
        </ul>

        {/* Bottom math: the five contributions sum to the total. House-POV
            color on the final line (positive → emerald, negative → rose)
            per CLAUDE.md. */}
        <div className="border-t border-border/60 pt-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold uppercase tracking-wider">
              P&amp;L Today
            </span>
            <span
              className={cn(
                "font-bold tabular-nums",
                houseAmountTextClass(isProfit ? 1 : -1),
              )}
            >
              {isProfit ? "+" : "−"}
              {formatCurrency(Math.abs(pnl))}
            </span>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * One component row inside the today-P&L popover. The icon chip uses a
 * neutral muted tint (informational); the amount carries the House-POV
 * color from its signed contribution so a shrinking liability reads
 * emerald even though the underlying delta is negative — matching the
 * analytics Period-P&L breakdown's AmountCell.
 */
function TodayBreakdownRow({
  label,
  description,
  contribution,
  icon: Icon,
}: {
  label: string;
  description: string;
  contribution: number;
  icon: LucideIcon;
}) {
  const positive = contribution >= 0;
  const sign = positive ? "+" : "−";
  const amountColor = positive
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-rose-600 dark:text-rose-400";
  // Row bumped 11px → text-xs (12px) and description 10px → 11px —
  // at the prior sizes the popover felt like a tooltip the user had
  // to squint at; now it reads as a proper breakdown table.
  return (
    <li className="flex items-center justify-between gap-2 rounded px-1 py-0.5 text-xs hover:bg-muted/40">
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="flex size-5 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
          <Icon className="size-3" />
        </span>
        <span className="min-w-0">
          <span className="block truncate font-medium text-foreground/90">
            {label}
          </span>
          <span className="block truncate text-[11px] text-muted-foreground">
            {description}
          </span>
        </span>
      </span>
      <span className={cn("shrink-0 font-semibold tabular-nums", amountColor)}>
        {sign}
        {formatCurrency(Math.abs(contribution))}
      </span>
    </li>
  );
}
