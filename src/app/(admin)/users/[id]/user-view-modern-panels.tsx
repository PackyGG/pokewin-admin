"use client";

/**
 * Shared primitives + "modern" stat panels used by the modern user detail
 * view. Split out of user-view-modern.tsx to keep files focused and under
 * ~500 lines. Pure presentation — no data fetching, no side effects.
 */

import * as React from "react";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Wallet,
  TrendingUp,
  TrendingDown,
  Activity,
  RefreshCw,
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
import { ROLLING_PNL_WIPE_HINT } from "./user-tabs-types";

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
  action,
  children,
}: {
  title: string;
  icon: React.ElementType;
  accent: keyof typeof TILE_COLORS;
  // Optional right-aligned slot in the header, e.g. for the Balances
  // panel's refresh icon button.
  action?: React.ReactNode;
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
      <div className="relative p-4 sm:p-5">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <div className={cn("flex size-7 items-center justify-center rounded-lg shrink-0", colors.bg)}>
              <Icon className={cn("size-3.5", colors.icon)} />
            </div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground truncate">
              {title}
            </h3>
          </div>
          {action}
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

/**
 * One rung of the Overview "Rolling P&L" block. When `wiped` is true the
 * window crosses an admin wipe → the windowed-P&L formula is undefined, so we
 * render a neutral "—" (with the shared hint as a native tooltip) instead of
 * the phantom number. Otherwise it renders the house-POV colored value
 * (positive = house gain = emerald, negative = house loss = rose). Mirrors the
 * Account-tab windowed-P&L strip exactly so both surfaces agree.
 */
function RollingPnlRow({
  label,
  pnl,
  wiped,
}: {
  label: string;
  pnl: number;
  wiped: boolean;
}) {
  if (wiped) {
    return (
      <PanelRow
        label={label}
        value={
          <span className="text-muted-foreground" title={ROLLING_PNL_WIPE_HINT}>
            —
          </span>
        }
      />
    );
  }
  return (
    <PanelRow
      label={label}
      value={
        <span
          className={cn(
            pnl >= 0
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-rose-600 dark:text-rose-400",
          )}
        >
          {pnl >= 0 ? "+" : ""}
          {formatCurrency(pnl)}
        </span>
      }
    />
  );
}

export function ModernBalancePanel({
  balances,
  userId,
  pnl7d,
  canAdjustBalance = false,
  canRecordManualWithdrawal = false,
}: {
  balances: UserDetail["balances"];
  userId?: string;
  // The user's rolling 7-day house P&L — the SAME value shown in the
  // "Past 7d" rung of the P&L panel (`pnlBreakdown.pnl7d`). Threaded into
  // the Adjust-Balance dialog so the Lossback section auto-fills it (no
  // drift vs the Accounts tab). Serializable number — safe across the
  // server→client boundary.
  pnl7d?: number;
  canAdjustBalance?: boolean;
  canRecordManualWithdrawal?: boolean;
}) {
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  // Soft-refresh the page server data when the admin clicks the icon —
  // re-runs the parent server components without a hard browser
  // reload, so the user keeps their tab focus / scroll position and
  // the rest of the page DOM stays intact while the balance numbers
  // re-fetch. useTransition wraps the call so the icon can show a
  // pending spinner without blocking the rest of the UI.
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const handleRefresh = () => {
    startRefresh(() => {
      router.refresh();
    });
  };
  const refreshAction = (
    <Button
      variant="ghost"
      size="icon"
      onClick={handleRefresh}
      disabled={refreshing}
      className="size-7"
      title="Reload balances"
      aria-label="Reload balances"
    >
      <RefreshCw
        className={cn("size-3.5", refreshing && "animate-spin")}
      />
    </Button>
  );

  if (!balances) {
    return (
      <StatPanel
        title="Balances"
        icon={Wallet}
        accent="emerald"
        action={refreshAction}
      >
        <p className="text-sm text-muted-foreground">No balance data</p>
      </StatPanel>
    );
  }
  const total =
    balances.availableBalance + balances.inventoryValue + balances.vouchersValue;
  const showAdjust = canAdjustBalance && Boolean(userId);
  // Show the manual-withdrawal button whenever the admin has the
  // capability — it's also useful at $0 balance for backfilling
  // historical off-platform payouts so P&L counts them.
  const showManual = canRecordManualWithdrawal && Boolean(userId);
  return (
    <StatPanel
      title="Balances"
      icon={Wallet}
      accent="emerald"
      action={refreshAction}
    >
      <div className="space-y-0.5">
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
          Total Value
        </p>
        <p className="text-2xl sm:text-3xl font-bold tabular-nums text-emerald-600 dark:text-emerald-400 truncate">
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
          availableBalance={balances.availableBalance}
          pnl7d={pnl7d}
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
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground truncate">
          Deposits − Withdrawals − Balance − Inventory
        </p>
        <p
          className={cn(
            "text-2xl sm:text-3xl font-bold tabular-nums truncate",
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
      {/* Rolling windowed P&L — house P&L over the past 12h / 24h / 3d
          / 7d / 14d (now − N, NOT calendar buckets), as a windowed
          delta. House POV: gain = emerald, loss = rose. Five rungs so
          the row reads from acute (12h) to baseline (14d) and admins
          can spot short-term spikes vs longer trends. The Account tab
          surfaces the same five windows as a horizontal tile strip
          alongside the wagering stats. */}
      <div className="mt-3 space-y-0.5 border-t pt-3">
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
          Rolling P&amp;L
        </p>
        <RollingPnlRow
          label="Past 12h"
          pnl={pnlBreakdown.pnl12h}
          wiped={pnlBreakdown.wiped12h}
        />
        <RollingPnlRow
          label="Past 24h"
          pnl={pnlBreakdown.pnl24h}
          wiped={pnlBreakdown.wiped24h}
        />
        <RollingPnlRow
          label="Past 3d"
          pnl={pnlBreakdown.pnl3d}
          wiped={pnlBreakdown.wiped3d}
        />
        <RollingPnlRow
          label="Past 7d"
          pnl={pnlBreakdown.pnl7d}
          wiped={pnlBreakdown.wiped7d}
        />
        <RollingPnlRow
          label="Past 14d"
          pnl={pnlBreakdown.pnl14d}
          wiped={pnlBreakdown.wiped14d}
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
      <div className="flex flex-wrap items-baseline gap-4">
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
            Level
          </p>
          <p className="text-2xl sm:text-3xl font-bold tabular-nums text-blue-600 dark:text-blue-400">
            {statistics?.level ?? 0}
          </p>
        </div>
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
            XP
          </p>
          <p className="text-base sm:text-lg font-semibold tabular-nums text-muted-foreground truncate">
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
  hint,
}: {
  label: string;
  value: string;
  accent: keyof typeof TILE_COLORS;
  icon: React.ElementType;
  /**
   * Optional small muted sub-label shown under the value (and surfaced as the
   * tile's native `title` tooltip). Used by the rolling-P&L strip to explain a
   * "—" reset tile ("windowed P&L can't be computed across an admin wipe").
   * Omitted on every other tile → unchanged layout there.
   */
  hint?: string;
}) {
  const colors = TILE_COLORS[accent] ?? TILE_COLORS.blue;
  return (
    <div
      className={cn("rounded-xl border p-3 sm:p-4 min-w-0", colors.bg)}
      title={hint ?? undefined}
    >
      <div className="flex items-center gap-2">
        <Icon className={cn("size-4 shrink-0", colors.icon)} />
        <span className="text-[10px] sm:text-[11px] font-semibold uppercase tracking-wider text-muted-foreground truncate">
          {label}
        </span>
      </div>
      <p className={cn("mt-1 text-xl sm:text-2xl font-bold tabular-nums truncate", colors.text)}>
        {value}
      </p>
      {hint ? (
        <p className="mt-1 text-[10px] leading-snug text-muted-foreground line-clamp-2">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

