"use client";

/**
 * Shared primitives + "modern" stat panels used by the modern user detail
 * view. Split out of user-view-modern.tsx to keep files focused and under
 * ~500 lines. Pure presentation — no data fetching, no side effects.
 */

import * as React from "react";
import { useState } from "react";
import {
  Wallet,
  TrendingUp,
  TrendingDown,
  Activity,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils/format";
import { Button } from "@/components/ui/button";
import {
  BalanceAdjustDialog,
  ManualWithdrawalDialog,
  XpAdjustDialog,
} from "./user-tabs-dialogs";
import type {
  UserDetail,
  PnlBreakdown,
} from "./user-tabs-types";

// ───────────────────────────────────────────────────────────────────
//  SHARED COLOR TOKENS
// ───────────────────────────────────────────────────────────────────

export const TILE_COLORS: Record<
  string,
  { bg: string; text: string; icon: string }
> = {
  blue: {
    bg: "bg-blue-500/10 border-blue-500/20",
    text: "text-blue-600 dark:text-blue-400",
    icon: "text-blue-500",
  },
  emerald: {
    bg: "bg-emerald-500/10 border-emerald-500/20",
    text: "text-emerald-600 dark:text-emerald-400",
    icon: "text-emerald-500",
  },
  rose: {
    bg: "bg-rose-500/10 border-rose-500/20",
    text: "text-rose-600 dark:text-rose-400",
    icon: "text-rose-500",
  },
  cyan: {
    bg: "bg-cyan-500/10 border-cyan-500/20",
    text: "text-cyan-600 dark:text-cyan-400",
    icon: "text-cyan-500",
  },
  amber: {
    bg: "bg-amber-500/10 border-amber-500/20",
    text: "text-amber-600 dark:text-amber-400",
    icon: "text-amber-500",
  },
  purple: {
    bg: "bg-purple-500/10 border-purple-500/20",
    text: "text-purple-600 dark:text-purple-400",
    icon: "text-purple-500",
  },
};

// ───────────────────────────────────────────────────────────────────
//  SECTION HEADING
// ───────────────────────────────────────────────────────────────────

export function SectionHeading({
  icon: Icon,
  title,
}: {
  icon: React.ElementType;
  title: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <div className="rounded-md bg-primary/10 p-1.5">
        <Icon className="size-4 text-primary" />
      </div>
      <h3 className="text-base font-semibold">{title}</h3>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────
//  MODERN STAT PANELS — used in the Overview tab
// ───────────────────────────────────────────────────────────────────

export function StatPanel({
  title,
  icon: Icon,
  accent,
  children,
}: {
  title: string;
  icon: React.ElementType;
  accent: keyof typeof TILE_COLORS;
  children: React.ReactNode;
}) {
  const colors = TILE_COLORS[accent] ?? TILE_COLORS.blue;
  return (
    <div className="relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-card/80">
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute -right-12 -top-12 size-32 rounded-full blur-2xl opacity-40",
          colors.bg,
        )}
      />
      <div className="relative p-5">
        <div className="mb-3 flex items-center gap-2">
          <div className={cn("flex size-7 items-center justify-center rounded-lg", colors.bg)}>
            <Icon className={cn("size-3.5", colors.icon)} />
          </div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {title}
          </h3>
        </div>
        {children}
      </div>
    </div>
  );
}

export function PanelRow({
  label,
  value,
  valueClassName,
}: {
  label: string;
  value: React.ReactNode;
  valueClassName?: string;
}) {
  return (
    <div className="flex items-center justify-between py-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("font-medium tabular-nums", valueClassName)}>{value}</span>
    </div>
  );
}

export function ModernBalancePanel({
  balances,
  userId,
  canAdjustBalance = false,
  canRecordManualWithdrawal = false,
}: {
  balances: UserDetail["balances"];
  userId?: string;
  canAdjustBalance?: boolean;
  canRecordManualWithdrawal?: boolean;
}) {
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);

  if (!balances) {
    return (
      <StatPanel title="Balances" icon={Wallet} accent="emerald">
        <p className="text-sm text-muted-foreground">No balance data</p>
      </StatPanel>
    );
  }
  const total =
    balances.availableBalance + balances.inventoryValue + balances.vouchersValue;
  const showAdjust = canAdjustBalance && Boolean(userId);
  // Disable the manual-withdrawal button when there's nothing to deduct from.
  const showManual =
    canRecordManualWithdrawal &&
    Boolean(userId) &&
    balances.availableBalance > 0;
  return (
    <StatPanel title="Balances" icon={Wallet} accent="emerald">
      <div className="space-y-0.5">
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
          Total Value
        </p>
        <p className="text-3xl font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
          {formatCurrency(total)}
        </p>
      </div>
      <div className="mt-4 space-y-0.5 border-t pt-3">
        <PanelRow label="Cash" value={formatCurrency(balances.availableBalance)} />
        <PanelRow label="Locked" value={formatCurrency(balances.lockedBalance)} />
        <PanelRow label="Inventory" value={formatCurrency(balances.inventoryValue)} />
        <PanelRow label="Vouchers" value={formatCurrency(balances.vouchersValue)} />
      </div>
      {(showAdjust || showManual) && (
        <div className="mt-3 pt-3 border-t space-y-2">
          {showAdjust && (
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => setAdjustOpen(true)}
            >
              Adjust Balance
            </Button>
          )}
          {showManual && (
            <Button
              variant="outline"
              size="sm"
              className="w-full text-rose-600 hover:text-rose-600 dark:text-rose-400 dark:hover:text-rose-400 border-rose-500/40 hover:bg-rose-500/10"
              onClick={() => setManualOpen(true)}
              title="Record an off-platform payout (deducts on-site balance + bumps total_withdrawn so PnL stays correct)"
            >
              Record Manual Withdrawal
            </Button>
          )}
        </div>
      )}
      {showAdjust && userId && (
        <BalanceAdjustDialog
          userId={userId}
          open={adjustOpen}
          onOpenChange={setAdjustOpen}
        />
      )}
      {showManual && userId && (
        <ManualWithdrawalDialog
          userId={userId}
          availableBalance={balances.availableBalance}
          open={manualOpen}
          onOpenChange={setManualOpen}
        />
      )}
    </StatPanel>
  );
}

export function ModernPnlPanel({
  balances,
  pnlBreakdown,
}: {
  balances: UserDetail["balances"];
  pnlBreakdown: PnlBreakdown;
}) {
  // True house-perspective P&L for this user, matching CLAUDE.md's
  // financial coloring rule:
  //
  //   pnl = deposits − withdrawals − (available + locked balance)
  //                   − inventory value − voucher liability
  //
  // i.e. money we've captured minus money we still owe the user. If the
  // user has more sitting on-site than they've deposited (paper win),
  // the number goes negative and we show red.
  const deposits = balances?.totalDeposited ?? 0;
  const withdrawals = balances?.totalWithdrawn ?? 0;
  const onSiteBalance =
    (balances?.availableBalance ?? 0) + (balances?.lockedBalance ?? 0);
  const inventoryValue = balances?.inventoryValue ?? 0;
  const vouchersValue = balances?.vouchersValue ?? 0;
  const pnl =
    deposits - withdrawals - onSiteBalance - inventoryValue - vouchersValue;
  const isProfit = pnl >= 0;
  const Icon = isProfit ? TrendingUp : TrendingDown;
  return (
    <StatPanel title="Platform P&L" icon={Icon} accent={isProfit ? "emerald" : "rose"}>
      <div className="space-y-0.5">
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
          Deposits − Withdrawals − Balance − Inventory
        </p>
        <p
          className={cn(
            "text-3xl font-bold tabular-nums",
            isProfit ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400",
          )}
        >
          {isProfit ? "+" : ""}
          {formatCurrency(pnl)}
        </p>
      </div>
      <div className="mt-4 space-y-0.5 border-t pt-3">
        <PanelRow label="Deposited" value={formatCurrency(deposits)} />
        <PanelRow label="Withdrawn" value={formatCurrency(withdrawals)} />
        <PanelRow label="On-site balance" value={`-${formatCurrency(onSiteBalance)}`} />
        <PanelRow label="Inventory value" value={`-${formatCurrency(inventoryValue)}`} />
        {vouchersValue > 0 ? (
          <PanelRow label="Unclaimed vouchers" value={`-${formatCurrency(vouchersValue)}`} />
        ) : null}
        <PanelRow
          label="Bonuses given"
          value={
            <span className="text-rose-500">
              -{formatCurrency(pnlBreakdown.bonusesCost)}
            </span>
          }
        />
      </div>
    </StatPanel>
  );
}

export function ModernActivityPanel({
  statistics,
  balances,
  inventoryCount,
  avgDeposit,
  userId,
  canAdjustXp = false,
}: {
  statistics: UserDetail["statistics"];
  balances: UserDetail["balances"];
  inventoryCount: number;
  avgDeposit: number;
  userId?: string;
  canAdjustXp?: boolean;
}) {
  const [xpAdjustOpen, setXpAdjustOpen] = useState(false);

  const houseEdge =
    balances && balances.totalWagered > 0
      ? ((balances.totalWagered - balances.totalWon) / balances.totalWagered) * 100
      : 0;
  const showXpAdjust = canAdjustXp && Boolean(userId);
  return (
    <StatPanel title="Activity" icon={Activity} accent="blue">
      <div className="flex items-baseline gap-4">
        <div>
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
            Level
          </p>
          <p className="text-3xl font-bold tabular-nums text-blue-600 dark:text-blue-400">
            {statistics?.level ?? 0}
          </p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
            XP
          </p>
          <p className="text-lg font-semibold tabular-nums text-muted-foreground">
            {(statistics?.xp ?? 0).toLocaleString()}
          </p>
        </div>
      </div>
      <div className="mt-4 space-y-0.5 border-t pt-3">
        <PanelRow label="Packs Opened" value={String(statistics?.openedPacks ?? 0)} />
        <PanelRow label="Battles Played" value={String(statistics?.battlesPlayed ?? 0)} />
        <PanelRow label="Inventory Items" value={String(inventoryCount)} />
        <PanelRow label="Avg Deposit" value={formatCurrency(avgDeposit)} />
        <PanelRow
          label="Avg House Edge"
          value={balances && balances.totalWagered > 0 ? `${houseEdge.toFixed(2)}%` : "—"}
        />
      </div>
      {showXpAdjust && (
        <div className="mt-3 pt-3 border-t">
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => setXpAdjustOpen(true)}
          >
            Adjust XP
          </Button>
        </div>
      )}
      {showXpAdjust && userId && (
        <XpAdjustDialog
          userId={userId}
          open={xpAdjustOpen}
          onOpenChange={setXpAdjustOpen}
        />
      )}
    </StatPanel>
  );
}

// ───────────────────────────────────────────────────────────────────
//  COMPACT METRIC TILE — used in-tab (e.g. CreatorTab)
// ───────────────────────────────────────────────────────────────────

/**
 * Compact metric tile — similar to the hero KPI tile but for in-tab use.
 * Kept inline rather than reusing the hero KpiTile so in-tab tiles can
 * have their own sizing rules independent of the hero.
 */
export function ModernMetricTile({
  label,
  value,
  accent,
  icon: Icon,
}: {
  label: string;
  value: string;
  accent: keyof typeof TILE_COLORS;
  icon: React.ElementType;
}) {
  const colors = TILE_COLORS[accent] ?? TILE_COLORS.blue;
  return (
    <div className={cn("rounded-xl border p-4", colors.bg)}>
      <div className="flex items-center gap-2">
        <Icon className={cn("size-4", colors.icon)} />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
      </div>
      <p className={cn("mt-1 text-2xl font-bold tabular-nums", colors.text)}>
        {value}
      </p>
    </div>
  );
}

