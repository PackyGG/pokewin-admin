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
  return (
    <Card
      className={cn(
        // House-POV tinted face + a matching hairline ring so the state
        // reads at a glance: house in profit → emerald, house in the red →
        // rose. The ring deepens the tint into a defined panel edge.
        isProfit
          ? "bg-emerald-500/10 ring-emerald-500/20"
          : "bg-rose-500/10 ring-rose-500/20",
      )}
    >
      <CardHeader className="flex flex-row items-start justify-between gap-2 pb-1.5">
        <div className="flex min-w-0 flex-col gap-0.5">
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
            Since 00:00 · {dayLabel}
          </span>
        </div>
        {/* Trend glyph in a tinted chip so it reads as a status badge, not a
            loose icon — the headline color cue for the whole tile. */}
        <span
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-lg",
            isProfit
              ? "bg-emerald-500/15 text-emerald-400"
              : "bg-rose-500/15 text-rose-400",
          )}
        >
          {isProfit ? (
            <TrendingUp className="size-4" />
          ) : (
            <TrendingDown className="size-4" />
          )}
        </span>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-stat-value truncate leading-none">
          <span className={isProfit ? "text-emerald-400" : "text-rose-400"}>
            {isProfit ? "+" : "−"}
            <AnimatedNumber value={Math.abs(pnl)} format="currency" />
          </span>
        </div>
        {/* Deposits / Withdrawals chips — the two headline components of
            the day, mirroring the referenced card. Deposits = capital in
            (emerald, good for house); Withdrawals = money out (rose).
            Sits below a hairline divider so the headline P&L and its two
            drivers read as a clear two-tier hierarchy. */}
        <div className="grid grid-cols-2 gap-1.5 border-t border-border/50 pt-3">
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
        </div>
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
}: {
  label: string;
  value: number;
  tone: "emerald" | "rose";
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
        "rounded-lg border bg-background/40 px-2.5 py-2 min-w-0",
        border,
      )}
    >
      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground truncate">
        {label}
      </p>
      <p
        className={cn(
          "mt-0.5 text-sm font-semibold tabular-nums truncate",
          valueColor,
        )}
      >
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
  // Signed contribution to house P&L per the canonical formula:
  //   pnl = deposits − withdrawals − balanceΔ − inventoryΔ − voucherΔ
  // Deposits add; every other term subtracts. These five sum to `pnl`.
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
      contribution: -withdrawals,
      icon: ArrowUpFromLine,
    },
    {
      id: "balance",
      label: "User Balance Δ",
      description: "Net change in user available + locked balance",
      contribution: -balanceChange,
      icon: Wallet,
    },
    {
      id: "inventory",
      label: "Inventory Δ",
      description: "Cards obtained minus cards sold/exchanged",
      contribution: -inventoryChange,
      icon: Box,
    },
    {
      id: "voucher",
      label: "Voucher Δ",
      description: "Vouchers issued minus vouchers claimed",
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
              deposits − withdrawals − balanceΔ − inventoryΔ − voucherΔ
            </span>{" "}
            over the day. Same formula as the period-P&amp;L card and the
            daily-P&amp;L chart. Real customers only (staff + excluded users
            dropped).
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
