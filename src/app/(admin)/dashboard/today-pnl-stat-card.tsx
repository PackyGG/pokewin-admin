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

/**
 * "P&L Today" dashboard tile — house P&L for the CURRENT CALENDAR DAY
 * since 00:00 (NOT a rolling past-24h window).
 *
 * The number is the canonical windowed-delta P&L over [today 00:00 UTC,
 * now): deposits − withdrawals − balanceΔ − inventoryΔ − voucherΔ (see
 * getTodayPnl / calculateWindowedPnl). Because it's the same formula the
 * period-P&L card and daily-P&L chart use, this reconciles with them.
 *
 * House-POV colors per CLAUDE.md:
 *   • P&L ≥ 0 → house in profit → emerald (card tint + value).
 *   • P&L < 0 → house in the red → rose.
 * The card face also shows the two largest plain components — Deposits
 * (emerald, capital in) and Withdrawals (rose, money out) — matching the
 * shape of the daily P&L card the operator referenced. The Info popover
 * (styled exactly like the GGR breakdown button) spells out every
 * component with its signed contribution to house P&L.
 *
 * All props are serializable primitives — no function props cross the RSC
 * boundary (AnimatedNumber takes the `format` string-enum, not a
 * formatter fn) per CLAUDE.md / Next 15.
 */
export function TodayPnlStatCard({
  pnl,
  deposits,
  withdrawals,
  balanceChange,
  inventoryChange,
  voucherChange,
  /** YYYY-MM-DD (UTC) — the calendar day this P&L covers. */
  dayLabel,
}: {
  pnl: number;
  deposits: number;
  withdrawals: number;
  balanceChange: number;
  inventoryChange: number;
  voucherChange: number;
  dayLabel: string;
}) {
  const isProfit = pnl >= 0;
  // Net change in user holdings (balance + inventory + vouchers). When
  // negative, user liabilities shrank — partially offsets deposits vs
  // withdrawals on the headline P&L figure.
  const netHoldingsChange = balanceChange + inventoryChange + voucherChange;
  const netHoldingsPnlContribution = -netHoldingsChange;
  return (
    <Card className={cn(isProfit ? "bg-emerald-500/10" : "bg-rose-500/10")}>
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
          <CardTitle className="text-card-title text-muted-foreground inline-flex items-center gap-1">
            P&amp;L Today
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
        {isProfit ? (
          <TrendingUp className="size-4 shrink-0 text-emerald-400" />
        ) : (
          <TrendingDown className="size-4 shrink-0 text-rose-400" />
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-stat-value truncate">
          <span className={isProfit ? "text-emerald-400" : "text-rose-400"}>
            {isProfit ? "+" : "−"}
            <AnimatedNumber value={Math.abs(pnl)} format="currency" />
          </span>
        </div>
        {/* Deposits / Withdrawals / Net holdings — deposits − withdrawals
            alone does NOT equal P&L; the third chip explains the gap. */}
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
          <TodayComponentChip
            label="Net holdings Δ"
            value={Math.abs(netHoldingsChange)}
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
        <p className="text-[10px] leading-snug text-muted-foreground">
          P&amp;L ≠ deposits − withdrawals. Balance, inventory, and voucher
          movement also count — open the{" "}
          <span className="font-medium text-foreground/80">info</span> icon for
          the full five-term breakdown (balance-sheet movement, not GGR).
        </p>
      </CardContent>
    </Card>
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
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground truncate">
        {label}
      </p>
      <p className={cn("text-xs font-semibold tabular-nums truncate", valueColor)}>
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
  // Gross withdrawals on the chip; popover derives the signed formula term
  // from the headline total so manual-withdrawal sign never breaks the sum.
  const withdrawalsFormulaTerm =
    deposits - balanceChange - inventoryChange - voucherChange - pnl;
  const withdrawalsContribution = -withdrawalsFormulaTerm;
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
          <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
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
                isProfit ? "text-emerald-400" : "text-rose-400",
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
  return (
    <li className="flex items-center justify-between gap-2 rounded px-1 py-0.5 text-[11px] hover:bg-muted/40">
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="flex size-5 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
          <Icon className="size-3" />
        </span>
        <span className="min-w-0">
          <span className="block truncate font-medium text-foreground/90">
            {label}
          </span>
          <span className="block truncate text-[10px] text-muted-foreground">
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
