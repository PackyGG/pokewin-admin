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
 */

import * as React from "react";
import { useMemo, useState, useEffect } from "react";
import {
  Wallet,
  TrendingUp,
  TrendingDown,
  Package,
  Swords,
  Gem,
  Trophy,
  Gift,
  Coins,
  ShieldCheck,
  FileText,
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  Sparkles,
  Percent,
  Calendar,
  MapPin,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
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
  BalanceSummaryCard,
  PnlCard,
  ActivityStatsCard,
  RewardsCard,
  CategoryTransactionsTable,
  AccountDetailsSection,
  FeatureLocksCard,
  ModerationSection,
  NotesSection,
  DisposedCardsTable,
  InventoryGrid,
  GAMING_TX_TYPES,
  FINANCIAL_TX_TYPES,
} from "./user-tabs";
import type { UserRewards } from "@/lib/queries/users";

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
  //   < 0  we lost money (user cashed out more than they deposited) → RED
  const totalValue =
    (balances?.availableBalance ?? 0) + (balances?.inventoryValue ?? 0);
  const pnl = balances ? balances.totalDeposited - balances.totalWithdrawn : 0;
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

      {activeTab === "creator" && <CreatorTab />}

      {activeTab === "account" && (
        <AccountTab data={data} notes={notes} isAdmin={isAdmin} />
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────
//  KPI TILE
// ───────────────────────────────────────────────────────────────────

const TILE_COLORS: Record<string, { bg: string; text: string; icon: string }> =
  {
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
        "group relative overflow-hidden rounded-xl border px-4 py-3 transition-all hover:shadow-md min-w-[160px]",
        colors.bg,
      )}
    >
      <div className="flex items-center gap-2">
        <Icon className={cn("size-4", colors.icon)} />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
      </div>
      <p
        className={cn(
          "mt-1 text-xl font-bold tabular-nums leading-tight",
          colors.text,
        )}
      >
        {value}
      </p>
      {sub && (
        <p className="mt-0.5 text-[11px] text-muted-foreground truncate">
          {sub}
        </p>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────
//  TABS
// ───────────────────────────────────────────────────────────────────

function OverviewTab({
  data,
  gamingTx,
  financialTx,
  pnlBreakdown,
}: {
  data: UserDetail;
  gamingTx: PaginatedTransactions;
  financialTx: PaginatedTransactions;
  pnlBreakdown: PnlBreakdown;
  isAdmin: boolean;
}) {
  const { user, balances, statistics, counts } = data;

  return (
    <div className="space-y-6">
      {/* Modern stat panels — purpose-built to match the hero aesthetic:
          rounded-2xl, subtle colored corner glow, color-accented icon
          chip + hero number + breakdown rows below. */}
      <div className="grid gap-4 md:grid-cols-3">
        <ModernBalancePanel balances={balances} />
        <ModernPnlPanel balances={balances} pnlBreakdown={pnlBreakdown} />
        <ModernActivityPanel
          statistics={statistics}
          balances={balances}
          inventoryCount={data.inventoryCount}
          avgDeposit={counts.avgDeposit}
        />
      </div>

      {/* Deposits & Withdrawals — recent financial activity on overview
          per admin request. Full history still lives on Finances tab. */}
      <SectionHeading icon={ArrowDownToLine} title="Deposits & Withdrawals" />
      <CategoryTransactionsTable
        title="Deposits & Withdrawals"
        userId={user.id}
        types={FINANCIAL_TX_TYPES}
        initialTx={financialTx}
        cardWithdrawals={data.cardWithdrawals}
      />

      {/* Recent activity — unified timeline (gaming + financial). Colors
          are flipped to HOUSE perspective: if the user made money the
          dot/amount shows RED (we lost), user losses show GREEN. */}
      <SectionHeading icon={Activity} title="Recent Activity" />
      <RecentActivityTimeline
        gamingTx={gamingTx.data.slice(0, 5)}
        financialTx={financialTx.data.slice(0, 5)}
      />
    </div>
  );
}

function RewardsTab({ rewards }: { rewards: UserRewards }) {
  return (
    <div className="space-y-6">
      <SectionHeading icon={Gift} title="Rewards" />
      <RewardsCard rewards={rewards} />
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────
//  MODERN STAT PANELS — used in the Overview tab
// ───────────────────────────────────────────────────────────────────

function StatPanel({
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

function PanelRow({
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

function ModernBalancePanel({ balances }: { balances: UserDetail["balances"] }) {
  if (!balances) {
    return (
      <StatPanel title="Balances" icon={Wallet} accent="emerald">
        <p className="text-sm text-muted-foreground">No balance data</p>
      </StatPanel>
    );
  }
  const total =
    balances.availableBalance + balances.inventoryValue + balances.vouchersValue;
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
    </StatPanel>
  );
}

function ModernPnlPanel({
  balances,
  pnlBreakdown,
}: {
  balances: UserDetail["balances"];
  pnlBreakdown: PnlBreakdown;
}) {
  // Same calc as the hero KPI strip (house perspective: deposits minus
  // withdrawals) so the two P&L numbers on this page always agree.
  // Previously this panel showed gambling PnL (wagers - won) which is a
  // different metric and didn't match the header — that mismatch was
  // confusing.
  const pnl = balances ? balances.totalDeposited - balances.totalWithdrawn : 0;
  const isProfit = pnl >= 0;
  const Icon = isProfit ? TrendingUp : TrendingDown;
  return (
    <StatPanel title="Platform P&L" icon={Icon} accent={isProfit ? "emerald" : "rose"}>
      <div className="space-y-0.5">
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
          Deposits − Withdrawals
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
        <PanelRow label="Deposited" value={formatCurrency(balances?.totalDeposited ?? 0)} />
        <PanelRow label="Withdrawn" value={formatCurrency(balances?.totalWithdrawn ?? 0)} />
        <PanelRow label="Wagered" value={formatCurrency(balances?.totalWagered ?? 0)} />
        <PanelRow label="Won" value={formatCurrency(balances?.totalWon ?? 0)} />
        <PanelRow
          label="Bonuses Cost"
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

function ModernActivityPanel({
  statistics,
  balances,
  inventoryCount,
  avgDeposit,
}: {
  statistics: UserDetail["statistics"];
  balances: UserDetail["balances"];
  inventoryCount: number;
  avgDeposit: number;
}) {
  const houseEdge =
    balances && balances.totalWagered > 0
      ? ((balances.totalWagered - balances.totalWon) / balances.totalWagered) * 100
      : 0;
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
    </StatPanel>
  );
}

function FinancesTab({
  data,
  financialTx,
  isAdmin,
}: {
  data: UserDetail;
  financialTx: PaginatedTransactions;
  isAdmin: boolean;
}) {
  const { user, balances, capabilities } = data;
  void isAdmin; // reserved for future action-gating in this tab
  void balances;
  void capabilities;
  return (
    <div className="space-y-6">
      <SectionHeading icon={ArrowDownToLine} title="Deposits & Withdrawals" />
      <CategoryTransactionsTable
        title="Deposits & Withdrawals"
        userId={user.id}
        types={FINANCIAL_TX_TYPES}
        initialTx={financialTx}
        cardWithdrawals={data.cardWithdrawals}
      />
    </div>
  );
}

function GamingTab({
  data,
  gamingTx,
}: {
  data: UserDetail;
  gamingTx: PaginatedTransactions;
}) {
  const { user } = data;
  return (
    <div className="space-y-6">
      <SectionHeading icon={Swords} title="Gaming Transactions" />
      <CategoryTransactionsTable
        title="Gaming"
        userId={user.id}
        types={GAMING_TX_TYPES}
        initialTx={gamingTx}
        showCardsValue
      />
    </div>
  );
}

function InventoryTab({ data }: { data: UserDetail }) {
  const { user, balances } = data;
  // NOTE: the classic view lazy-loads inventory. For the modern view we
  // just mount the InventoryGrid with an empty initial set — it will
  // fetch on mount via its internal mechanism the same way the classic
  // tab does when opened.
  return (
    <div className="space-y-6">
      <SectionHeading icon={Gem} title="Current Inventory" />
      <InventoryGrid
        userId={user.id}
        initialInventory={emptyInventoryPage()}
        inventoryValue={balances?.inventoryValue ?? 0}
        statusFilter="owned"
      />
      <SectionHeading icon={Trophy} title="Sold & Exchanged" />
      <DisposedCardsTable
        userId={user.id}
        initialInventory={emptyInventoryPage()}
      />
    </div>
  );
}

function CreatorTab() {
  // Creator section is complex (has its own data fetch via lazy-load
  // elsewhere). For now, inform the admin to use classic view for full
  // creator context — this tab will get a dedicated rebuild in a
  // follow-up batch once the core modern layout is approved.
  return (
    <Card>
      <CardContent className="py-12 text-center text-sm text-muted-foreground">
        <Sparkles className="mx-auto size-8 opacity-50" />
        <p className="mt-3">
          Full Creator / Affiliate data — switch to Classic view for the
          detailed breakdown. Modern version coming next.
        </p>
      </CardContent>
    </Card>
  );
}

function AccountTab({
  data,
  notes,
  isAdmin,
}: {
  data: UserDetail;
  notes: AdminNote[];
  isAdmin: boolean;
}) {
  const { user, shippingAddress, vault, depositAddresses, featureLocks, mutes, capabilities } = data;
  void isAdmin; // currently only consumed by downstream components
  return (
    <div className="space-y-6">
      <SectionHeading icon={ShieldCheck} title="Account Details" />
      <Card>
        <CardContent className="pt-6">
          <AccountDetailsSection
            user={user}
            shippingAddress={shippingAddress}
            vault={vault}
            depositAddresses={depositAddresses}
          />
        </CardContent>
      </Card>
      <SectionHeading icon={ShieldCheck} title="Feature Locks" />
      <FeatureLocksCard
        userId={user.id}
        featureLocks={featureLocks}
        canToggle={capabilities.canToggleFeatureLocks}
      />
      <SectionHeading icon={ShieldCheck} title="Moderation" />
      <Card>
        <CardContent className="pt-6">
          <ModerationSection user={user} mutes={mutes} />
        </CardContent>
      </Card>
      <SectionHeading icon={FileText} title="Admin Notes" />
      <NotesSection userId={user.id} notes={notes} />
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────
//  HELPERS
// ───────────────────────────────────────────────────────────────────

function SectionHeading({
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

type TxRow = PaginatedTransactions["data"][number];

// Simple unified timeline merging gaming + financial into one chronological feed.
function RecentActivityTimeline({
  gamingTx,
  financialTx,
}: {
  gamingTx: TxRow[];
  financialTx: TxRow[];
}) {
  const merged = useMemo(() => {
    return [...gamingTx, ...financialTx]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, 8);
  }, [gamingTx, financialTx]);

  if (merged.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          No recent activity.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="pt-6">
        <ol className="relative ml-3 border-l border-border">
          {merged.map((tx) => {
            const delta = tx.balanceAfter - tx.balanceBefore;
            // HOUSE perspective: user gained money (delta > 0) → we LOST →
            // red. User lost money (delta < 0) → we WON → green.
            const userGained = delta > 0;
            const Icon = iconFor(tx.type);
            return (
              <li key={tx.id} className="relative mb-4 pl-6 last:mb-0">
                <span
                  className={cn(
                    "absolute -left-[9px] top-0 flex size-4 items-center justify-center rounded-full border-2 border-background",
                    userGained ? "bg-rose-500" : "bg-emerald-500",
                  )}
                >
                  <span className="size-1.5 rounded-full bg-background" />
                </span>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Icon className="size-4 text-muted-foreground" />
                    <span className="text-sm font-medium capitalize">
                      {tx.type.replace(/_/g, " ")}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {formatRelative(tx.createdAt)}
                    </span>
                  </div>
                  <span
                    className={cn(
                      "text-sm font-semibold tabular-nums",
                      userGained ? "text-rose-500" : "text-emerald-500",
                    )}
                  >
                    {userGained ? "+" : ""}
                    {formatCurrency(tx.amount)}
                  </span>
                </div>
                {tx.description && (
                  <p className="mt-0.5 text-xs text-muted-foreground truncate">
                    {tx.description}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}

function iconFor(type: string): React.ElementType {
  if (type.startsWith("battle")) return Swords;
  if (type === "pack_opening") return Package;
  if (type === "deposit" || type === "deposit_bonus") return ArrowDownToLine;
  if (type.includes("withdrawal")) return ArrowUpFromLine;
  if (type === "race_prize" || type === "rain_win") return Trophy;
  if (type === "rakeback_claim" || type === "balance_reward_claim") return Gift;
  return Coins;
}

// Empty inventory page placeholder — InventoryGrid fetches its own data
// on mount, so we start with an empty paginated shape.
function emptyInventoryPage() {
  return {
    data: [],
    total: 0,
    page: 1,
    perPage: 24,
    totalPages: 0,
  };
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
