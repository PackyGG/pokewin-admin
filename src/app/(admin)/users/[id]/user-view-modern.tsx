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

  // KPIs surfaced in the hero strip
  const totalValue =
    (balances?.availableBalance ?? 0) + (balances?.inventoryValue ?? 0);
  const pnl = balances ? balances.totalWithdrawn - balances.totalDeposited : 0;
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

        <div className="relative p-6 md:p-8">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
            {/* Identity */}
            <div className="flex items-start gap-5">
              <div className="relative shrink-0">
                <Avatar className="size-20 ring-4 ring-background shadow-xl">
                  {user.image && <AvatarImage src={user.image} alt="" />}
                  <AvatarFallback className="text-lg font-semibold">
                    {(user.username ?? user.email ?? "?")
                      .slice(0, 2)
                      .toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <span
                  className={cn(
                    "absolute -bottom-1 -right-1 size-5 rounded-full border-2 border-background",
                    statusKey === "active" && "bg-emerald-500",
                    statusKey === "locked" && "bg-amber-500",
                    statusKey === "banned" && "bg-rose-500",
                  )}
                  aria-label={statusLabel}
                />
              </div>

              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-2xl font-bold leading-tight truncate">
                    {displayName}
                  </h2>
                  {user.username && user.displayUsername &&
                    user.displayUsername !== user.username && (
                      <span className="text-sm text-muted-foreground">
                        @{user.username}
                      </span>
                    )}
                </div>
                <p className="text-sm text-muted-foreground truncate">
                  {user.email}
                  {user.emailVerified && (
                    <span className="ml-1.5 text-[10px] font-semibold text-emerald-500">
                      ✓ verified
                    </span>
                  )}
                </p>
                <div className="flex flex-wrap items-center gap-1.5 pt-1">
                  <Badge
                    variant="outline"
                    className={ROLE_COLORS[user.role] ?? ""}
                  >
                    {user.role}
                  </Badge>
                  <Badge
                    variant="outline"
                    className={USER_STATUS_COLORS[statusKey] ?? ""}
                  >
                    {statusLabel}
                  </Badge>
                  <Badge
                    variant="outline"
                    className={
                      user.twoFactorEnabled
                        ? "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30"
                        : "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30"
                    }
                  >
                    2FA {user.twoFactorEnabled ? "On" : "Off"}
                  </Badge>
                  {user.affiliateCode && (
                    <Badge
                      variant="outline"
                      className="bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30"
                    >
                      <Sparkles className="mr-1 size-3" />
                      {user.affiliateCode}
                    </Badge>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-3 pt-2 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <MapPin className="size-3" />
                    {user.country ?? user.countryCode ?? "Unknown"}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Calendar className="size-3" />
                    Joined {formatRelative(user.createdAt)}
                  </span>
                  <span className="font-mono">{user.id.slice(0, 8)}</span>
                </div>
              </div>
            </div>
          </div>

          {/* KPI Strip */}
          <div className="mt-8 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
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
              value={
                wagerMultiplier > 0 ? `${wagerMultiplier.toFixed(2)}×` : "—"
              }
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
          rewards={rewards}
          pnlBreakdown={pnlBreakdown}
          isAdmin={isAdmin}
        />
      )}

      {activeTab === "finances" && (
        <FinancesTab
          data={data}
          financialTx={financialTx}
          rewards={rewards}
          pnlBreakdown={pnlBreakdown}
          isAdmin={isAdmin}
        />
      )}

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
        "group relative overflow-hidden rounded-xl border p-4 transition-all hover:shadow-md",
        colors.bg,
      )}
    >
      <div className="flex items-start justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <Icon className={cn("size-4", colors.icon)} />
      </div>
      <p
        className={cn(
          "mt-2 text-xl font-bold tabular-nums leading-tight",
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
  rewards,
  pnlBreakdown,
  isAdmin,
}: {
  data: UserDetail;
  gamingTx: PaginatedTransactions;
  financialTx: PaginatedTransactions;
  rewards: UserRewards;
  pnlBreakdown: PnlBreakdown;
  isAdmin: boolean;
}) {
  const { user, balances, statistics, capabilities, counts } = data;

  return (
    <div className="space-y-6">
      {/* Top: 3 key metric cards (keep the proven classic cards here —
          they're already well-designed, just in a cleaner container) */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <BalanceSummaryCard
          balances={balances}
          userId={user.id}
          isAdmin={isAdmin}
          canAdjustBalance={capabilities.canAdjustBalance}
        />
        <PnlCard pnlBreakdown={pnlBreakdown} balances={balances} />
        <ActivityStatsCard
          statistics={statistics}
          balances={balances}
          inventoryCount={data.inventoryCount}
          bonusPoints={balances?.bonusPoints ?? 0}
          avgDeposit={counts.avgDeposit}
          userId={user.id}
          canAdjustXp={capabilities.canAdjustXp}
        />
      </div>

      {/* Rewards snapshot */}
      <SectionHeading icon={Gift} title="Rewards" />
      <RewardsCard rewards={rewards} />

      {/* Recent activity — unified timeline */}
      <SectionHeading icon={Activity} title="Recent Activity" />
      <RecentActivityTimeline
        gamingTx={gamingTx.data.slice(0, 5)}
        financialTx={financialTx.data.slice(0, 5)}
      />
    </div>
  );
}

function FinancesTab({
  data,
  financialTx,
  rewards,
  pnlBreakdown,
  isAdmin,
}: {
  data: UserDetail;
  financialTx: PaginatedTransactions;
  rewards: UserRewards;
  pnlBreakdown: PnlBreakdown;
  isAdmin: boolean;
}) {
  const { user, balances, capabilities } = data;
  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2">
        <BalanceSummaryCard
          balances={balances}
          userId={user.id}
          isAdmin={isAdmin}
          canAdjustBalance={capabilities.canAdjustBalance}
        />
        <PnlCard pnlBreakdown={pnlBreakdown} balances={balances} />
      </div>
      <SectionHeading icon={ArrowDownToLine} title="Deposits & Withdrawals" />
      <CategoryTransactionsTable
        title="Deposits & Withdrawals"
        userId={user.id}
        types={FINANCIAL_TX_TYPES}
        initialTx={financialTx}
        cardWithdrawals={data.cardWithdrawals}
      />
      <SectionHeading icon={Gift} title="Rewards" />
      <RewardsCard rewards={rewards} />
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
            const positive = delta > 0;
            const Icon = iconFor(tx.type);
            return (
              <li key={tx.id} className="relative mb-4 pl-6 last:mb-0">
                <span
                  className={cn(
                    "absolute -left-[9px] top-0 flex size-4 items-center justify-center rounded-full border-2 border-background",
                    positive ? "bg-emerald-500" : "bg-rose-500",
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
                      positive ? "text-emerald-500" : "text-rose-500",
                    )}
                  >
                    {positive ? "+" : ""}
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
