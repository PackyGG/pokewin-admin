"use client";

/**
 * Tab panel components for the modern user detail view. Each tab receives
 * the already-fetched data from the parent UserViewModern component and
 * renders the relevant sections. Pure presentation — data lives in the
 * parent, mutations flow through the shared section components.
 */

import * as React from "react";
import { useMemo } from "react";
import {
  Wallet,
  TrendingUp,
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
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatCurrency, formatRelative } from "@/lib/utils/format";
import {
  amountColorFor,
  amountSignFor,
  ledgerDirection,
} from "@/lib/utils/ledger-direction";
import {
  type UserDetail,
  type PaginatedTransactions,
  type PnlBreakdown,
  type AdminNote,
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
import {
  SectionHeading,
  ModernBalancePanel,
  ModernPnlPanel,
  ModernActivityPanel,
  ModernMetricTile,
} from "./user-view-modern-panels";

// ───────────────────────────────────────────────────────────────────
//  OVERVIEW TAB
// ───────────────────────────────────────────────────────────────────

export function OverviewTab({
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
  const { user, balances, statistics, counts, capabilities } = data;

  return (
    <div className="space-y-6">
      {/* Modern stat panels — purpose-built to match the hero aesthetic:
          rounded-2xl, subtle colored corner glow, color-accented icon
          chip + hero number + breakdown rows below. */}
      <div className="grid gap-4 md:grid-cols-3">
        <ModernBalancePanel
          balances={balances}
          userId={user.id}
          canAdjustBalance={capabilities.canAdjustBalance}
        />
        <ModernPnlPanel balances={balances} pnlBreakdown={pnlBreakdown} />
        <ModernActivityPanel
          statistics={statistics}
          balances={balances}
          inventoryCount={data.inventoryCount}
          avgDeposit={counts.avgDeposit}
          userId={user.id}
          canAdjustXp={capabilities.canAdjustXp}
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

// ───────────────────────────────────────────────────────────────────
//  REWARDS TAB
// ───────────────────────────────────────────────────────────────────

export function RewardsTab({ rewards }: { rewards: UserRewards }) {
  return (
    <div className="space-y-6">
      <SectionHeading icon={Gift} title="Rewards" />
      <RewardsCard rewards={rewards} />
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────
//  FINANCES TAB
// ───────────────────────────────────────────────────────────────────

export function FinancesTab({
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

// ───────────────────────────────────────────────────────────────────
//  GAMING TAB
// ───────────────────────────────────────────────────────────────────

export function GamingTab({
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

// ───────────────────────────────────────────────────────────────────
//  INVENTORY TAB
// ───────────────────────────────────────────────────────────────────

export function InventoryTab({ data }: { data: UserDetail }) {
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

// ───────────────────────────────────────────────────────────────────
//  CREATOR TAB
// ───────────────────────────────────────────────────────────────────

export function CreatorTab({ data }: { data: UserDetail }) {
  const { user, affiliate } = data;
  // For creators, send admins to the dedicated /creators/[userId] page
  // which has the full affiliate panel (deals, webhooks, payouts, code
  // analytics, clicks, signups, etc.). Replicating all that inline on
  // the user page would be duplication — one source of truth is cleaner.
  return (
    <div className="space-y-4">
      <Card className="overflow-hidden">
        <CardContent className="flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-lg bg-purple-500/15">
              <Sparkles className="size-5 text-purple-500" />
            </div>
            <div>
              <p className="text-sm font-semibold">Creator / Affiliate</p>
              <p className="text-xs text-muted-foreground">
                {user.affiliateCode
                  ? `Code ${user.affiliateCode}`
                  : "No affiliate code"}
                {affiliate ? ` · ${affiliate.totalReferred} referred` : ""}
              </p>
            </div>
          </div>
          <a
            href={`/creators/${user.id}`}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Open Creator Dashboard
            <span aria-hidden>→</span>
          </a>
        </CardContent>
      </Card>

      {affiliate && (
        <div className="grid gap-4 md:grid-cols-3">
          <ModernMetricTile
            label="Total Referred"
            value={affiliate.totalReferred.toLocaleString()}
            accent="purple"
            icon={Sparkles}
          />
          <ModernMetricTile
            label="Wager Volume"
            value={formatCurrency(affiliate.totalWagerVolumeUsd)}
            accent="cyan"
            icon={Coins}
          />
          {/* All four tiles below describe money the HOUSE paid (or
              will pay) this creator and their users → house-loss side
              of the ledger → rose per CLAUDE.md. */}
          <ModernMetricTile
            label="Total Earned"
            value={formatCurrency(affiliate.totalEarnedUsd)}
            accent="rose"
            icon={TrendingUp}
          />
          <ModernMetricTile
            label="Available"
            value={formatCurrency(affiliate.availableUsd)}
            accent="rose"
            icon={Wallet}
          />
          <ModernMetricTile
            label="Paid Out"
            value={formatCurrency(affiliate.totalPaidOutUsd)}
            accent="rose"
            icon={ArrowUpFromLine}
          />
          <ModernMetricTile
            label="Bonus Distributed"
            value={formatCurrency(affiliate.totalBonusDistributedUsd)}
            accent="rose"
            icon={Gift}
          />
        </div>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────
//  ACCOUNT TAB
// ───────────────────────────────────────────────────────────────────

export function AccountTab({
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
//  RECENT ACTIVITY TIMELINE — used by OverviewTab
// ───────────────────────────────────────────────────────────────────

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
            // Classify by ledger TYPE rather than balance delta — for
            // deposits and withdrawals the delta sign is the user's
            // direction, not the house's (deposit lowers external cash
            // but raises balance, withdrawal does the opposite).
            const dir = ledgerDirection(tx.type);
            const Icon = iconFor(tx.type);
            const dotBg =
              dir === "house-loss"
                ? "bg-rose-500"
                : dir === "house-gain"
                  ? "bg-emerald-500"
                  : "bg-blue-500";
            return (
              <li key={tx.id} className="relative mb-4 pl-6 last:mb-0">
                <span
                  className={cn(
                    "absolute -left-[9px] top-0 flex size-4 items-center justify-center rounded-full border-2 border-background",
                    dotBg,
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
                      amountColorFor(dir),
                    )}
                  >
                    {amountSignFor(dir)}
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
