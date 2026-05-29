import Link from "next/link";
import { type ElementType } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Wallet,
  Box,
  Ticket,
  Coins,
  ArrowRight,
} from "lucide-react";
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

/**
 * "Where the P&L comes from" panel — the canonical realized-P&L
 * breakdown rendered as a list of contributing terms.
 *
 *   realized P&L = deposits − withdrawals − user balances
 *                  − open inventory − unclaimed vouchers
 *                  − unclaimed rakeback
 *
 * Each row links to the surface where that term can be drilled into.
 * Rendered on the Analytics → Overview tab. Server component — no
 * client JS.
 */

type Row = {
  label: string;
  description: string;
  value: number;
  /** Whether this term ADDS to P&L (deposits) or subtracts (everything else). */
  sign: "+" | "−";
  icon: ElementType;
  href?: string;
};

export function PnlBreakdown({
  total,
  breakdown,
}: {
  total: number;
  breakdown: {
    totalDeposits: number;
    totalWithdrawals: number;
    userBalance: number;
    inventory: number;
    vouchers: number;
    unclaimedRakeback: number;
  };
}) {
  const rows: Row[] = [
    {
      label: "Deposits",
      description: "Completed real-money deposits credited to balances",
      value: breakdown.totalDeposits,
      sign: "+",
      icon: ArrowDownToLine,
      href: "/transactions/deposits",
    },
    {
      label: "Withdrawals",
      description: "Card withdrawals shipped or completed",
      value: breakdown.totalWithdrawals,
      sign: "−",
      icon: ArrowUpFromLine,
      href: "/withdrawals",
    },
    {
      label: "User Balances",
      description: "Available + locked balances on real-user accounts",
      value: breakdown.userBalance,
      sign: "−",
      icon: Wallet,
      href: "/users?sortBy=balance&sortOrder=desc",
    },
    {
      label: "Open Inventory",
      description: "Cards still on user accounts at value_at_obtained",
      value: breakdown.inventory,
      sign: "−",
      icon: Box,
      href: "/users?sortBy=inventoryValue&sortOrder=desc",
    },
    {
      label: "Unclaimed Vouchers",
      description: "Vouchers issued to users but not yet claimed",
      value: breakdown.vouchers,
      sign: "−",
      icon: Ticket,
      href: "/vouchers",
    },
    {
      label: "Unclaimed Rakeback",
      description: "Rakeback owed to users but not yet redeemed",
      value: breakdown.unclaimedRakeback,
      sign: "−",
      icon: Coins,
      href: "/rewards/rakeback",
    },
  ];

  const isProfit = total >= 0;

  return (
    <div className="rounded-2xl border bg-gradient-to-br from-card via-card to-card/80 p-4 sm:p-5">
      {/* Header: title + description. On phones, the total sits in its
          own dedicated row above the rows so the title doesn't have to
          fight for horizontal space with a 24px-bold currency value. */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h3 className="text-base font-semibold leading-tight">
            Where the P&amp;L comes from
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Each row contributes to the total below. Click any row to
            drill into the underlying users / transactions.
          </p>
        </div>
        <div
          className={cn(
            "flex items-center justify-between gap-3 rounded-xl border px-3 py-2 sm:block sm:border-0 sm:p-0 sm:text-right",
            isProfit
              ? "border-emerald-500/30 bg-emerald-500/10 sm:bg-transparent"
              : "border-rose-500/30 bg-rose-500/10 sm:bg-transparent",
          )}
        >
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Realized P&amp;L
          </p>
          <p
            className={cn(
              "text-xl font-bold tabular-nums sm:text-2xl",
              isProfit ? "text-emerald-500" : "text-rose-500",
            )}
          >
            {isProfit ? "+" : "−"}
            {formatCurrency(Math.abs(total))}
          </p>
        </div>
      </div>

      <div className="divide-y rounded-xl border">
        {rows.map((r) => (
          <PnlRow key={r.label} row={r} />
        ))}
      </div>
    </div>
  );
}

function PnlRow({ row }: { row: Row }) {
  const isPositive = row.sign === "+";
  const color = isPositive
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-rose-600 dark:text-rose-400";
  const bg = isPositive ? "bg-emerald-500/10" : "bg-rose-500/10";
  const Icon = row.icon;

  // Mobile layout: the description gets clipped to a single line beside
  // the label. At sm+ it stays as the muted descriptor under the label,
  // matching the original visual hierarchy. The amount + arrow stay
  // right-aligned at every breakpoint so admins can scan numbers.
  const inner = (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div
          className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${bg}`}
        >
          <Icon className={`size-4 ${color}`} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium leading-tight">
            {row.label}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {row.description}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <p
          className={`text-sm font-semibold tabular-nums sm:text-base ${color}`}
        >
          {row.sign}
          {formatCurrency(row.value)}
        </p>
        {row.href && (
          <ArrowRight className="size-4 text-muted-foreground opacity-50 transition-opacity group-hover:opacity-100" />
        )}
      </div>
    </>
  );

  if (row.href) {
    return (
      <Link
        href={row.href}
        className="group flex items-center justify-between gap-3 px-3 py-3 transition-colors hover:bg-muted/40 sm:px-4"
      >
        {inner}
      </Link>
    );
  }
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-3 sm:px-4">
      {inner}
    </div>
  );
}
