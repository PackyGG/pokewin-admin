"use client";

/**
 * Modern, design-forward redesign of the user detail page. Built as a
 * parallel view to the existing UserTabs "classic" layout — admins can
 * toggle between them via the switcher at the top.
 *
 * Design principles:
 *   - One big hero panel with the identity + key metrics at a glance
 *   - Gradient accents to give a modern, premium feel without leaving
 *     the shadcn design language
 *   - Segmented pill-tabs replacing the old tall accordion list
 *   - Every number uses tabular-nums for clean alignment
 *   - Reuses the proven section components from user-tabs.tsx rather
 *     than reimplementing logic — only the *shell* is new
 *
 * This file hosts the top-level wrapper + hero KPI strip + tab bar. The
 * per-tab content lives in ./user-view-modern-tabs.tsx and the shared
 * stat panels live in ./user-view-modern-panels.tsx.
 */

import * as React from "react";
import { useMemo, useState, useEffect } from "react";
import {
  Wallet,
  TrendingUp,
  TrendingDown,
  Swords,
  Gem,
  Gift,
  Coins,
  ShieldCheck,
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  Sparkles,
  Percent,
  Calendar,
  MapPin,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { formatCurrency, formatRelative } from "@/lib/utils/format";
import { ROLE_COLORS, USER_STATUS_COLORS } from "@/lib/constants";
import {
  type UserDetail,
  type PaginatedTransactions,
  type PnlBreakdown,
  type AdminNote,
} from "./user-tabs";
import type { UserRewards } from "@/lib/queries/users";
import { TILE_COLORS } from "./user-view-modern-panels";
import {
  OverviewTab,
  FinancesTab,
  RewardsTab,
  GamingTab,
  InventoryTab,
  CreatorTab,
  AccountTab,
} from "./user-view-modern-tabs";

// ---------------------------------------------------------------------------
// Re-exports — preserve the public surface so call sites that previously
// imported from this module keep working.
// ---------------------------------------------------------------------------
export {
  OverviewTab,
  FinancesTab,
  RewardsTab,
  GamingTab,
  InventoryTab,
  CreatorTab,
  AccountTab,
} from "./user-view-modern-tabs";
export {
  TILE_COLORS,
  SectionHeading,
  StatPanel,
  PanelRow,
  ModernBalancePanel,
  ModernPnlPanel,
  ModernActivityPanel,
  ModernMetricTile,
} from "./user-view-modern-panels";

type TabKey =
  | "overview"
  | "finances"
  | "rewards"
  | "gaming"
  | "inventory"
  | "creator"
  | "account";

type TabDef = {
  key: TabKey;
  label: string;
  icon: React.ElementType;
  // Show conditionally (e.g. creator tab only if user has affiliate code)
  show?: (data: UserDetail) => boolean;
};

const TABS: TabDef[] = [
  { key: "overview", label: "Overview", icon: Activity },
  { key: "finances", label: "Finances", icon: Wallet },
  { key: "rewards", label: "Rewards", icon: Gift },
  { key: "gaming", label: "Gaming", icon: Swords },
  { key: "inventory", label: "Inventory", icon: Gem },
  {
    key: "creator",
    label: "Creator",
    icon: Sparkles,
    show: (d) => Boolean(d.user.affiliateCode),
  },
  { key: "account", label: "Account", icon: ShieldCheck },
];

export function UserViewModern({
  data,
  gamingTx,
  financialTx,
  rewards,
  notes,
  pnlBreakdown,
}: {
  data: UserDetail;
  gamingTx: PaginatedTransactions;
  financialTx: PaginatedTransactions;
  rewards: UserRewards;
  notes: AdminNote[];
  pnlBreakdown: PnlBreakdown;
}) {
  const { user, balances, counts } = data;
  const isAdmin = data.sessionRole === "admin";
  const [activeTab, setActiveTab] = useState<TabKey>("overview");

  const visibleTabs = useMemo(
    () => TABS.filter((t) => !t.show || t.show(data)),
    [data],
  );

  const statusKey = user.isBanned ? "banned" : user.isLocked ? "locked" : "active";
  const statusLabel = user.isBanned
    ? "Banned"
    : user.isLocked
      ? "Locked"
      : "Active";

  // KPIs surfaced in the hero strip.
  // P&L is expressed from the HOUSE perspective:
  //   pnl = deposits - withdrawals
  //   > 0  we made money (user deposited more than they withdrew)  → GREEN
  //   < 0  we lost money (user holds more than they deposited net) → RED
  //
  // Note: matches the Platform P&L panel below — includes on-site balance
  // and inventory value as liabilities so paper wins flip the sign to red.
  const totalValue =
    (balances?.availableBalance ?? 0) + (balances?.inventoryValue ?? 0);
  const deposits = balances?.totalDeposited ?? 0;
  const withdrawals = balances?.totalWithdrawn ?? 0;
  const onSiteBalance =
    (balances?.availableBalance ?? 0) + (balances?.lockedBalance ?? 0);
  const inventoryValue = balances?.inventoryValue ?? 0;
  const vouchersValue = balances?.vouchersValue ?? 0;
  const pnl =
    deposits - withdrawals - onSiteBalance - inventoryValue - vouchersValue;
  const wagerMultiplier =
    balances && balances.totalDeposited > 0
      ? balances.totalWagered / balances.totalDeposited
      : 0;
  const houseEdge =
    balances && balances.totalWagered > 0
      ? ((balances.totalWagered - balances.totalWon) / balances.totalWagered) *
        100
      : 0;

  const displayName =
    user.displayUsername ?? user.username ?? user.name ?? "—";

  return (
    <div className="space-y-6">
      {/* ── HERO ───────────────────────────────────────────────────── */}
      <div className="relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-card/60">
        {/* Subtle blue glow top-right */}
        <div
          aria-hidden
          className="pointer-events-none absolute -right-24 -top-24 size-72 rounded-full bg-blue-500/[0.06] blur-3xl"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -left-24 -bottom-24 size-72 rounded-full bg-purple-500/[0.06] blur-3xl"
        />

        <div className="relative p-5 md:p-6">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
            {/* Identity */}
            <div className="flex items-start gap-4 min-w-0">
              <div className="relative shrink-0">
                <Avatar className="size-14 ring-2 ring-background shadow-lg">
                  {user.image && <AvatarImage src={user.image} alt="" />}
                  <AvatarFallback className="text-sm font-semibold">
                    {(user.username ?? user.email ?? "?")
                      .slice(0, 2)
                      .toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <span
                  className={cn(
                    "absolute -bottom-0.5 -right-0.5 size-3.5 rounded-full border-2 border-background",
                    statusKey === "active" && "bg-emerald-500",
                    statusKey === "locked" && "bg-amber-500",
                    statusKey === "banned" && "bg-rose-500",
                  )}
                  aria-label={statusLabel}
                />
              </div>

              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-xl font-bold leading-tight truncate">
                    {displayName}
                  </h2>
                  {user.username && user.displayUsername &&
                    user.displayUsername !== user.username && (
                      <span className="text-sm text-muted-foreground">
                        @{user.username}
                      </span>
                    )}
                </div>
                <p className="text-xs text-muted-foreground truncate">
                  {user.email}
                  {user.emailVerified && (
                    <span className="ml-1.5 text-[10px] font-semibold text-emerald-500">
                      ✓
                    </span>
                  )}
                </p>
                <div className="flex flex-wrap items-center gap-1 pt-0.5">
                  <Badge
                    variant="outline"
                    className={cn("text-[10px] py-0 h-5", ROLE_COLORS[user.role] ?? "")}
                  >
                    {user.role}
                  </Badge>
                  <Badge
                    variant="outline"
                    className={cn("text-[10px] py-0 h-5", USER_STATUS_COLORS[statusKey] ?? "")}
                  >
                    {statusLabel}
                  </Badge>
                  <Badge
                    variant="outline"
                    className={cn(
                      "text-[10px] py-0 h-5",
                      user.twoFactorEnabled
                        ? "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30"
                        : "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
                    )}
                  >
                    2FA {user.twoFactorEnabled ? "On" : "Off"}
                  </Badge>
                  {user.affiliateCode && (
                    <Badge
                      variant="outline"
                      className="text-[10px] py-0 h-5 bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30"
                    >
                      <Sparkles className="mr-0.5 size-2.5" />
                      {user.affiliateCode}
                    </Badge>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2 pt-1 text-[11px] text-muted-foreground">
                  <span className="inline-flex items-center gap-0.5">
                    <MapPin className="size-2.5" />
                    {user.country ?? user.countryCode ?? "Unknown"}
                  </span>
                  <span className="inline-flex items-center gap-0.5">
                    <Calendar className="size-2.5" />
                    {formatRelative(user.createdAt)}
                  </span>
                  <span className="font-mono">{user.id.slice(0, 8)}</span>
                </div>
              </div>
            </div>

            {/* KPI strip — sits to the right of the identity on wide screens,
                wraps below on narrow. Tighter tiles than before so the hero
                stays compact. */}
            <div className="grid grid-cols-3 gap-2 shrink-0 lg:grid-cols-6">
              <KpiTile
                label="Total Value"
                value={formatCurrency(totalValue)}
                icon={Wallet}
                accent="blue"
              />
              <KpiTile
                label="P&L"
                value={`${pnl >= 0 ? "+" : ""}${formatCurrency(pnl)}`}
                icon={pnl >= 0 ? TrendingUp : TrendingDown}
                accent={pnl >= 0 ? "emerald" : "rose"}
              />
              <KpiTile
                label="Deposits"
                value={String(counts.deposits)}
                sub={formatCurrency(counts.avgDeposit) + " avg"}
                icon={ArrowDownToLine}
                accent="emerald"
              />
              <KpiTile
                label="Withdrawals"
                value={String(counts.withdrawals)}
                icon={ArrowUpFromLine}
                accent="cyan"
              />
              <KpiTile
                label="Multiplier"
                value={wagerMultiplier > 0 ? `${wagerMultiplier.toFixed(2)}×` : "—"}
                sub="wager / deposit"
                icon={Coins}
                accent="amber"
              />
              <KpiTile
                label="House Edge"
                value={balances && balances.totalWagered > 0 ? `${houseEdge.toFixed(2)}%` : "—"}
                icon={Percent}
                accent="purple"
              />
            </div>
          </div>
        </div>
      </div>

      {/* ── TAB BAR ────────────────────────────────────────────────── */}
      <div className="sticky top-2 z-20 rounded-xl border bg-card/80 p-1 backdrop-blur-md">
        <div className="flex flex-wrap gap-1">
          {visibleTabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={cn(
                  "inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-all",
                  isActive
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <Icon className="size-4" />
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── TAB CONTENT ────────────────────────────────────────────── */}
      {activeTab === "overview" && (
        <OverviewTab
          data={data}
          gamingTx={gamingTx}
          financialTx={financialTx}
          pnlBreakdown={pnlBreakdown}
          isAdmin={isAdmin}
        />
      )}

      {activeTab === "finances" && (
        <FinancesTab
          data={data}
          financialTx={financialTx}
          isAdmin={isAdmin}
        />
      )}

      {activeTab === "rewards" && <RewardsTab rewards={rewards} />}

      {activeTab === "gaming" && (
        <GamingTab data={data} gamingTx={gamingTx} />
      )}

      {activeTab === "inventory" && <InventoryTab data={data} />}

      {activeTab === "creator" && <CreatorTab data={data} />}

      {activeTab === "account" && (
        <AccountTab data={data} notes={notes} isAdmin={isAdmin} />
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────
//  KPI TILE — hero-only; tabs use ModernMetricTile from the panels file.
// ───────────────────────────────────────────────────────────────────

function KpiTile({
  label,
  value,
  sub,
  icon: Icon,
  accent = "blue",
}: {
  label: string;
  value: string;
  sub?: string;
  icon: React.ElementType;
  accent?: keyof typeof TILE_COLORS;
}) {
  const colors = TILE_COLORS[accent] ?? TILE_COLORS.blue;
  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-xl border px-5 py-4 transition-all hover:shadow-md min-w-[200px]",
        colors.bg,
      )}
    >
      <div className="flex items-center gap-2">
        <Icon className={cn("size-5", colors.icon)} />
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
      </div>
      <p
        className={cn(
          "mt-1.5 text-2xl font-bold tabular-nums leading-tight",
          colors.text,
        )}
      >
        {value}
      </p>
      {sub && (
        <p className="mt-1 text-xs text-muted-foreground truncate">
          {sub}
        </p>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────
//  VIEW SWITCHER (exported so user-tabs.tsx can render it at top)
// ───────────────────────────────────────────────────────────────────

const STORAGE_KEY = "user-detail-view";

export function UserViewSwitcher({
  view,
  onChange,
}: {
  view: "classic" | "modern";
  onChange: (v: "classic" | "modern") => void;
}) {
  return (
    <div className="flex gap-1 rounded-lg bg-muted p-1">
      {(["classic", "modern"] as const).map((v) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          className={cn(
            "inline-flex items-center gap-2 rounded-md px-4 py-1.5 text-sm font-medium transition-colors capitalize",
            view === v
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {v === "modern" ? (
            <>
              <Sparkles className="size-3.5" />
              Modern
              <Badge
                variant="outline"
                className="ml-1 bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30 px-1 py-0 text-[9px]"
              >
                NEW
              </Badge>
            </>
          ) : (
            <>Classic</>
          )}
        </button>
      ))}
    </div>
  );
}

export function useViewPreference(): ["classic" | "modern", (v: "classic" | "modern") => void] {
  const [view, setView] = useState<"classic" | "modern">("classic");

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === "classic" || stored === "modern") {
        setView(stored);
      }
    } catch {
      // localStorage unavailable — stick with default
    }
  }, []);

  const updateView = (v: "classic" | "modern") => {
    setView(v);
    try {
      localStorage.setItem(STORAGE_KEY, v);
    } catch {
      /* noop */
    }
  };

  return [view, updateView];
}
