"use client";

import {
  TrendingUp,
  TrendingDown,
  ArrowDownToLine,
  ArrowUpFromLine,
  Wallet,
  Box,
  Ticket,
  type LucideIcon,
} from "lucide-react";
import { AnimatedNumber } from "@/components/animated-number";
import {
  DashboardHeroBox,
  DashboardStatusChip,
  DashboardFaceChip,
  DashboardInfoPopover,
  DashboardPopoverHeader,
  DashboardBreakdownRow,
  DashboardBreakdownTotal,
} from "./_boxes";

/**
 * "P&L Today" dashboard tile — house P&L for the CURRENT CALENDAR DAY
 * since 00:00 (NOT a rolling past-24h window).
 *
 * The number is the canonical windowed-delta P&L over [today 00:00 UTC,
 * now): deposits − withdrawals − balanceΔ − inventoryΔ − voucherΔ (see
 * getTodayPnl / calculateWindowedPnl). Because it's the same formula the
 * period-P&L card and daily-P&L chart use, this reconciles with them.
 *
 * This is the quality bar for the dashboard box system: a tinted face +
 * matching hairline ring, a header with a title · info-popover · status
 * chip, the hero value, and a sub-chip row under a hairline divider. The
 * shared box primitives (./_boxes) now carry that look so every other
 * dashboard box reads as the same family; this tile composes them.
 *
 * House-POV colors per CLAUDE.md:
 *   • P&L ≥ 0 → house in profit → emerald (face + ring + value).
 *   • P&L < 0 → house in the red → rose.
 * The card face also shows the two largest plain components — Deposits
 * (emerald, capital in) and Withdrawals (rose, money out). The Info
 * popover spells out every component with its signed contribution to
 * house P&L.
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
  const accent = isProfit ? "emerald" : "rose";
  return (
    <DashboardHeroBox
      accent={accent}
      title={<>P&amp;L Today</>}
      caption={<>Since 00:00 · {dayLabel}</>}
      info={
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
      }
      chip={
        <DashboardStatusChip
          icon={isProfit ? TrendingUp : TrendingDown}
          accent={accent}
        />
      }
      value={
        <span className={isProfit ? "text-emerald-400" : "text-rose-400"}>
          {isProfit ? "+" : "−"}
          <AnimatedNumber value={Math.abs(pnl)} format="currency" />
        </span>
      }
      // Deposits / Withdrawals chips — the two headline components of the
      // day. Deposits = capital in (emerald, good for house); Withdrawals
      // = money out (rose).
      chips={
        <>
          <DashboardFaceChip
            label="Deposits"
            value={deposits}
            tone="emerald"
          />
          <DashboardFaceChip
            label="Withdrawals"
            value={withdrawals}
            tone="rose"
          />
        </>
      }
    />
  );
}

/**
 * Info popover for the today-P&L tile. Lists every P&L component with its
 * SIGNED contribution to house P&L and the math at the bottom (the five
 * contributions sum to the total). Each amount is colored House-POV: a
 * positive contribution (house gained / a liability shrank) is emerald, a
 * negative one (house paid / a liability grew) is rose — same convention
 * as the analytics Period-P&L breakdown.
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
    <DashboardInfoPopover
      accent={isProfit ? "emerald" : "rose"}
      label="Show today's P&L breakdown"
    >
      <DashboardPopoverHeader title={<>P&amp;L today · breakdown</>}>
        Since 00:00 today (UTC) — <strong>{dayLabel}</strong> — not a rolling
        24h window. House P&amp;L ={" "}
        <span className="font-mono">
          deposits − withdrawals − balanceΔ − inventoryΔ − voucherΔ
        </span>{" "}
        over the day. Same formula as the period-P&amp;L card and the
        daily-P&amp;L chart. Real customers only (staff + excluded users
        dropped).
      </DashboardPopoverHeader>

      {/* Component rows — each shows its SIGNED contribution to house P&L,
          House-POV colored (positive emerald, negative rose). */}
      <ul className="space-y-0.5">
        {rows.map((r) => {
          const positive = r.contribution >= 0;
          return (
            <DashboardBreakdownRow
              key={r.id}
              icon={r.icon}
              label={r.label}
              sub={r.description}
              amount={r.contribution}
              sign={positive ? "+" : "−"}
              tone={positive ? "emerald" : "rose"}
            />
          );
        })}
      </ul>

      {/* Bottom math: the five contributions sum to the total. */}
      <DashboardBreakdownTotal
        label={<>P&amp;L Today</>}
        amount={pnl}
        sign={isProfit ? "+" : "−"}
        tone={isProfit ? "emerald" : "rose"}
      />
    </DashboardInfoPopover>
  );
}
