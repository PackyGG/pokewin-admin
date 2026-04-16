"use client";

import React, { useEffect, useState, useTransition, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  ROLE_COLORS,
  USER_STATUS_COLORS,
  STATUS_COLORS,
} from "@/lib/constants";
import {
  formatCurrency,
  formatDateTime,
  formatRelative,
} from "@/lib/utils/format";
import {
  banUser,
  unbanUser,
  lockUser,
  unlockUser,
  deleteUser,
} from "../actions";
import type { UserRewards } from "@/lib/queries/users";
import {
  adjustBalance,
  adjustXp,
  changeRole,
  toggleFeatureLock,
  getGameSessionDetails,
  fetchInventory,
  fetchUserTransactions,
  updateWithdrawalLimits,
  fetchCreatorClicks,
  fetchCreatorCodeUsages,
  assignAffiliateCode,
  createAffiliateCode,
  fetchBalanceHistory,
  fetchCreatorWithdrawalLimits,
  wipeUserAccount,
} from "./actions";
import { createNote, deleteNote } from "./note-actions";
import { Switch } from "@/components/ui/switch";
import { CardImage } from "@/components/card-image";

type UserDetail = {
  user: {
    id: string;
    username: string | null;
    displayUsername: string | null;
    name: string | null;
    email: string | null;
    emailVerified: boolean;
    role: string;
    image: string | null;
    twoFactorEnabled: boolean;
    isBanned: boolean;
    bannedReason: string | null;
    bannedAt: string | null;
    bannedBy: string | null;
    isLocked: boolean;
    lockedReason: string | null;
    lockedAt: string | null;
    lockedBy: string | null;
    lockedUntil: string | null;
    country: string | null;
    countryCode: string | null;
    city: string | null;
    state: string | null;
    continentCode: string;
    signupIp: string | null;
    referredBy: string | null;
    referredByUsername: string | null;
    affiliateCode: string | null;
    affiliateCodeActive: boolean;
    affiliateCodeExpiresAt: string | null;
    affiliateBonusOptedIn: boolean;
    hasApiKey: boolean;
    createdAt: string;
    updatedAt: string;
    providers: string[];
    discord: {
      id: string;
      linkedAt: string | null;
    } | null;
  };
  balances: {
    availableBalance: number;
    lockedBalance: number;
    totalDeposited: number;
    totalWithdrawn: number;
    totalWagered: number;
    totalWon: number;
    bonusPoints: number;
    unlockAt: string | null;
    inventoryValue: number;
    vouchersValue: number;
    packsWagered: number;
    battlesWagered: number;
  } | null;
  statistics: {
    openedPacks: number;
    battlesPlayed: number;
    xp: number;
    level: number;
    weeklyWagerCount: number;
    lastWageredAt: string | null;
    currentDayWageredUsd: number;
    currentWeekWageredUsd: number;
    currentMonthWageredUsd: number;
    isProfilePrivate: boolean;
  } | null;
  featureLocks: {
    lockedWithdrawalsCrypto: boolean;
    lockedWithdrawalsItems: boolean;
    lockedInventorySales: boolean;
    lockedExchanges: boolean;
    lockedOpenings: boolean;
    lockedVault: boolean;
  } | null;
  inventoryCount: number;
  affiliate: {
    code: string;
    totalReferred: number;
    totalWagerVolumeUsd: number;
    totalEarnedUsd: number;
    availableUsd: number;
    totalPaidOutUsd: number;
    totalBonusDistributedUsd: number;
    lastPayoutAt: string | null;
  } | null;
  shippingAddress: {
    firstName: string;
    lastName: string;
    phoneCountryCode: string;
    phoneNumber: string;
    addressLine1: string;
    addressLine2: string | null;
    city: string;
    zipCode: string;
    stateProvince: string | null;
    country: string;
  } | null;
  vault: {
    id: string;
    name: string;
    customerRefId: string | null;
    fireblocksVaultId: string | null;
    createdAt: string;
  } | null;
  mutes: {
    id: string;
    mutedBy: string;
    reason: string | null;
    expiresAt: string | null;
    unmutedAt: string | null;
    unmutedBy: string | null;
    createdAt: string;
  }[];
  cardWithdrawals: {
    id: string;
    method: string;
    totalValueUsd: number;
    shippingFeeUsd: number | null;
    trackingNumber: string | null;
    carrier: string | null;
    status: string;
    failureReason: string | null;
    requestedAt: string;
    completedAt: string | null;
  }[];
  activeSeed: {
    clientSeed: string;
    serverSeedHash: string | null;
    nonce: number;
  } | null;
  depositAddresses: {
    id: string;
    assetId: string;
    address: string;
    tag: string | null;
    legacyAddress: string | null;
    createdAt: string;
  }[];
  counts: {
    deposits: number;
    withdrawals: number;
  };
  sessionRole: string;
};

type Transaction = {
  id: string;
  type: string;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  description: string;
  status: string;
  gameSessionId: string | null;
  packId: string | null;
  packName: string | null;
  cardsValue: number | null;
  inventoryValue: number;
  soldCard: {
    name: string;
    imageUrl: string | null;
    rarity: string | null;
  } | null;
  cryptoAsset: string | null;
  cryptoAmount: number | null;
  exchangeRate: number | null;
  blockchainTxHash: string | null;
  sourceAddress: string | null;
  destinationAddress: string | null;
  depositAddressId: string | null;
  failureReason: string | null;
  metadata: unknown;
  fireblocksTxId: string | null;
  externalTxId: string | null;
  createdAt: string;
  updatedAt: string;
};

type PaginatedTransactions = {
  data: Transaction[];
  total: number;
  page: number;
  perPage: number;
  totalPages: number;
};

type AuditEvent = {
  id: string;
  eventType: string;
  ip: string | null;
  country: string | null;
  createdAt: string;
  metadata: unknown;
};

type PaginatedAuditLog = {
  data: AuditEvent[];
  total: number;
  page: number;
  perPage: number;
  totalPages: number;
};

type InventoryItem = {
  id: string;
  cardName: string;
  imageUrl: string | null;
  rarity: string | null;
  value: number;
  sourceType: string;
  obtainedAt: string;
  soldAt: string | null;
  exchangedAt: string | null;
};

type PaginatedInventory = {
  data: InventoryItem[];
  total: number;
  page: number;
  perPage: number;
  totalPages: number;
};

type BalanceHistoryPoint = { date: string; balance: number };

type PnlBreakdown = {
  packRevenue: number;
  battleRevenue: number;
  cardSalesPayouts: number;
  gamblingPnlRealized: number;
  unrealizedLiability: number;
  gamblingPnlTrue: number;
  bonusesCost: number;
  rakebackCost: number;
  affiliateCost: number;
  otherCosts: number;
  otherCostsDetail: {
    rainWin: number;
    racePrize: number;
    balanceRewardClaim: number;
    creatorTip: number;
    voucherRedeemed: number;
    voucherExchange: number;
    exchangeExcessCredit: number;
    exchangeExcessToVoucher: number;
    battleExcessToVoucher: number;
  };
  netPnlRealized: number;
  netPnlTrue: number;
};

function PnlValue({ value }: { value: number }) {
  const color =
    value > 0
      ? "text-green-400"
      : value < 0
        ? "text-red-400"
        : "text-muted-foreground";
  return (
    <span className={`${color} font-medium tabular-nums`}>
      {value > 0 ? "+" : value < 0 ? "-" : ""}
      {formatCurrency(Math.abs(value))}
    </span>
  );
}

type AdminNote = {
  id: string;
  adminUserId: string;
  adminUsername: string;
  content: string;
  createdAt: string;
  updatedAt: string;
};

type CreatorClick = {
  id: number;
  code: string;
  userAgent: string | null;
  ip: string;
  country: string;
  region: string;
  city: string;
  createdAt: string | null;
};

type CreatorCodeUsage = {
  id: string;
  referredUserId: string;
  referredUsername: string | null;
  usageType: string;
  depositAmountUsd: number;
  wagerAmountUsd: number;
  referrerCutUsd: number;
  userBonusUsd: number;
  createdAt: string;
};

type WithdrawalLimits = {
  currencyLimitAmount: number | null;
  currencyLimitStartDate: string | null;
  currencyLimitResetDays: number | null;
  percentageLimit: number | null;
} | null;

type CreatorData = {
  clicks: {
    data: CreatorClick[];
    total: number;
    page: number;
    perPage: number;
    totalPages: number;
  };
  usages: {
    data: CreatorCodeUsage[];
    total: number;
    page: number;
    perPage: number;
    totalPages: number;
  };
  withdrawalLimits: WithdrawalLimits;
};

export function UserTabs({
  data,
  transactions,
  auditLog,
  inventory,
  soldInventory,
  exchangedInventory,
  pnlBreakdown,
  notes,
  gamingTx,
  financialTx,
  rewards,
}: {
  data: UserDetail;
  transactions: PaginatedTransactions;
  auditLog: PaginatedAuditLog;
  inventory: PaginatedInventory;
  soldInventory: PaginatedInventory;
  exchangedInventory: PaginatedInventory;
  pnlBreakdown: PnlBreakdown;
  notes: AdminNote[];
  gamingTx: PaginatedTransactions;
  financialTx: PaginatedTransactions;
  rewards: UserRewards;
}) {
  const {
    user,
    balances,
    statistics,
    featureLocks,
    sessionRole,
    affiliate,
    shippingAddress,
    vault,
    mutes,
    cardWithdrawals,
    activeSeed,
    depositAddresses,
    counts,
  } = data;
  const searchParams = useSearchParams();
  const initialTab = searchParams.has("txPage")
    ? "transactions"
    : searchParams.has("auditPage")
      ? "audit"
      : "overview";
  const [activeTab, setActiveTab] = useState(initialTab);
  const isAdmin = sessionRole === "admin";
  const router = useRouter();
  const [reloading, setReloading] = useState(false);
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    metrics: true,
    creator: true,
    gaming: true,
    financial: true,
    rewards: true,
    cardSales: true,
    exchanges: true,
    balanceHistory: false,
    inventory: true,
    soldCards: false,
    exchangedCards: false,
    accountDetails: false,
    featureLocks: false,
    moderation: false,
    notes: true,
  });
  const toggleSection = useCallback(
    (key: string) =>
      setOpenSections((prev) => ({ ...prev, [key]: !prev[key] })),
    [],
  );

  // Lazy-loaded data for deferred sections
  const [lazyData, setLazyData] = useState<{
    balanceHistory?: BalanceHistoryPoint[];
    cardSalesTx?: PaginatedTransactions;
    exchangeTx?: PaginatedTransactions;
    creatorData?: CreatorData | null;
  }>({});
  const [loadingSections, setLoadingSections] = useState<
    Record<string, boolean>
  >({});

  const loadSectionData = useCallback(
    async (sectionKey: string) => {
      if (loadingSections[sectionKey]) return;
      setLoadingSections((prev) => ({ ...prev, [sectionKey]: true }));
      try {
        switch (sectionKey) {
          case "balanceHistory": {
            const balanceHistory = await fetchBalanceHistory(user.id);
            setLazyData((prev) => ({ ...prev, balanceHistory }));
            break;
          }
          case "cardSales": {
            const cardSalesTx = await fetchUserTransactions(user.id, 1, 10, {
              types: [...CARD_SALE_TX_TYPES],
            });
            setLazyData((prev) => ({ ...prev, cardSalesTx }));
            break;
          }
          case "exchanges": {
            const exchangeTx = await fetchUserTransactions(user.id, 1, 10, {
              types: [...EXCHANGE_TX_TYPES],
            });
            setLazyData((prev) => ({ ...prev, exchangeTx }));
            break;
          }
          case "creator": {
            const [clicks, usages, withdrawalLimits] = await Promise.all([
              fetchCreatorClicks(user.affiliateCode ?? "", 1, 20),
              fetchCreatorCodeUsages(user.id, 1, 20),
              fetchCreatorWithdrawalLimits(user.id),
            ]);
            setLazyData((prev) => ({
              ...prev,
              creatorData: { clicks, usages, withdrawalLimits },
            }));
            break;
          }
        }
      } finally {
        setLoadingSections((prev) => ({ ...prev, [sectionKey]: false }));
      }
    },
    [user.id, user.affiliateCode, loadingSections],
  );

  // Auto-load data for sections that start open
  useEffect(() => {
    loadSectionData("cardSales");
    loadSectionData("exchanges");
    if (user.affiliateCode) loadSectionData("creator");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleToggleSection = useCallback(
    (key: string) => {
      toggleSection(key);
      // Load data on first open for lazy sections
      const lazyKeys = [
        "balanceHistory",
        "cardSales",
        "exchanges",
        "creator",
      ] as const;
      if (lazyKeys.includes(key as (typeof lazyKeys)[number])) {
        const dataMap: Record<string, unknown> = {
          balanceHistory: lazyData.balanceHistory,
          cardSales: lazyData.cardSalesTx,
          exchanges: lazyData.exchangeTx,
          creator: lazyData.creatorData,
        };
        if (dataMap[key] === undefined) {
          loadSectionData(key);
        }
      }
    },
    [toggleSection, lazyData, loadSectionData],
  );

  const handleReload = () => {
    setReloading(true);
    router.refresh();
    setTimeout(() => setReloading(false), 1000);
  };

  return (
    <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
      <div className="flex items-center gap-2">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="transactions">Transactions</TabsTrigger>
          <TabsTrigger value="audit">Audit Log</TabsTrigger>
        </TabsList>
        <Button
          variant="outline"
          size="icon"
          className="size-8"
          onClick={handleReload}
          disabled={reloading}
        >
          <RefreshCw
            className={`size-3.5 ${reloading ? "animate-spin" : ""}`}
          />
        </Button>
      </div>

      <TabsContent value="overview" className="space-y-6">
        {/* Zone 1 — Header Strip */}
        <UserHeaderStrip user={user} isAdmin={isAdmin} counts={counts} />

        {/* Zone 2 — Key Metrics */}
        <CollapsibleSection
          title="Key Metrics"
          sectionKey="metrics"
          open={openSections.metrics}
          onToggle={handleToggleSection}
        >
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            <BalanceSummaryCard
              balances={balances}
              userId={user.id}
              isAdmin={isAdmin}
            />
            <PnlCard pnlBreakdown={pnlBreakdown} balances={balances} />
            <ActivityStatsCard
              statistics={statistics}
              balances={balances}
              inventoryCount={data.inventoryCount}
              bonusPoints={balances?.bonusPoints ?? 0}
              userId={user.id}
              isAdmin={isAdmin}
            />
          </div>
        </CollapsibleSection>

        {/* Zone 2b — Transaction Sections. Gaming and Deposits sit
            directly under Key Metrics so the most-used views for fraud /
            moderation work are one glance away. Creator/Affiliate (a user
            identity section rather than a transaction view) is grouped
            later with Account Details / Feature Locks / Moderation. */}
        <CollapsibleSection
          title="Gaming"
          sectionKey="gaming"
          open={openSections.gaming}
          onToggle={handleToggleSection}
        >
          <CategoryTransactionsTable
            title="Gaming"
            userId={user.id}
            types={GAMING_TX_TYPES}
            initialTx={gamingTx}
            showCardsValue
          />
        </CollapsibleSection>

        <CollapsibleSection
          title="Deposits & Withdrawals"
          sectionKey="financial"
          open={openSections.financial}
          onToggle={handleToggleSection}
        >
          <CategoryTransactionsTable
            title="Deposits & Withdrawals"
            userId={user.id}
            types={FINANCIAL_TX_TYPES}
            initialTx={financialTx}
            cardWithdrawals={cardWithdrawals}
          />
        </CollapsibleSection>

        <CollapsibleSection
          title="Rewards"
          sectionKey="rewards"
          open={openSections.rewards}
          onToggle={handleToggleSection}
        >
          <RewardsCard rewards={rewards} />
        </CollapsibleSection>

        <CollapsibleSection
          title="Card Sales"
          sectionKey="cardSales"
          open={openSections.cardSales}
          onToggle={handleToggleSection}
        >
          {loadingSections.cardSales ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : lazyData.cardSalesTx ? (
            <CategoryTransactionsTable
              title="Card Sales"
              userId={user.id}
              types={CARD_SALE_TX_TYPES}
              initialTx={lazyData.cardSalesTx}
            />
          ) : null}
        </CollapsibleSection>

        <CollapsibleSection
          title="Exchanges"
          sectionKey="exchanges"
          open={openSections.exchanges}
          onToggle={handleToggleSection}
        >
          {loadingSections.exchanges ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : lazyData.exchangeTx ? (
            <CategoryTransactionsTable
              title="Exchanges"
              userId={user.id}
              types={EXCHANGE_TX_TYPES}
              initialTx={lazyData.exchangeTx}
            />
          ) : null}
        </CollapsibleSection>

        {/* Zone 3 — Balance History */}
        <CollapsibleSection
          title="Balance History"
          sectionKey="balanceHistory"
          open={openSections.balanceHistory}
          onToggle={handleToggleSection}
        >
          {loadingSections.balanceHistory ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : lazyData.balanceHistory ? (
            <BalanceHistoryChart data={lazyData.balanceHistory} />
          ) : (
            <p className="text-sm text-muted-foreground px-2">
              Click to load balance history
            </p>
          )}
        </CollapsibleSection>

        {/* Zone 3c — Inventory */}
        <CollapsibleSection
          title="Inventory"
          sectionKey="inventory"
          open={openSections.inventory}
          onToggle={handleToggleSection}
        >
          <InventoryGrid
            userId={user.id}
            initialInventory={inventory}
            inventoryValue={balances?.inventoryValue ?? 0}
          />
        </CollapsibleSection>

        {/* Zone 3c2 — Sold Cards */}
        <CollapsibleSection
          title="Sold Cards"
          sectionKey="soldCards"
          open={openSections.soldCards}
          onToggle={handleToggleSection}
        >
          <InventoryGrid
            userId={user.id}
            initialInventory={soldInventory}
            inventoryValue={0}
            statusFilter="sold"
          />
        </CollapsibleSection>

        {/* Zone 3c3 — Exchanged Cards */}
        <CollapsibleSection
          title="Exchanged Cards"
          sectionKey="exchangedCards"
          open={openSections.exchangedCards}
          onToggle={handleToggleSection}
        >
          <InventoryGrid
            userId={user.id}
            initialInventory={exchangedInventory}
            inventoryValue={0}
            statusFilter="exchanged"
          />
        </CollapsibleSection>

        {/* Zone 3d — Creator / Affiliate (conditional, moved here from
            under Key Metrics so the primary transaction sections come
            first for fraud / moderation review) */}
        {user.affiliateCode && (
          <CollapsibleSection
            title="Creator / Affiliate"
            sectionKey="creator"
            open={openSections.creator}
            onToggle={handleToggleSection}
          >
            {loadingSections.creator ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : lazyData.creatorData ? (
              <CreatorSection
                user={user}
                creatorData={lazyData.creatorData}
                affiliate={affiliate}
              />
            ) : null}
          </CollapsibleSection>
        )}

        {/* Zone 3e — Account Details */}
        <CollapsibleSection
          title="Account Details"
          sectionKey="accountDetails"
          open={openSections.accountDetails}
          onToggle={handleToggleSection}
        >
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

          {isAdmin && (
            <WipeAccountButton
              userId={user.id}
              displayName={user.username ?? user.email ?? user.id}
            />
          )}
        </CollapsibleSection>

        {/* Zone 4 — Feature Locks */}
        <CollapsibleSection
          title="Feature Locks"
          sectionKey="featureLocks"
          open={openSections.featureLocks}
          onToggle={handleToggleSection}
        >
          <FeatureLocksCard
            userId={user.id}
            featureLocks={featureLocks}
            isAdmin={isAdmin}
          />
        </CollapsibleSection>

        {/* Zone 5 — Moderation & Notes */}
        <CollapsibleSection
          title="Moderation"
          sectionKey="moderation"
          open={openSections.moderation}
          onToggle={handleToggleSection}
        >
          <Card>
            <CardContent className="pt-6">
              <ModerationSection user={user} mutes={mutes} />
            </CardContent>
          </Card>
        </CollapsibleSection>

        <CollapsibleSection
          title="Notes"
          sectionKey="notes"
          open={openSections.notes}
          onToggle={handleToggleSection}
        >
          <NotesSection userId={user.id} notes={notes} />
        </CollapsibleSection>
      </TabsContent>

      <TabsContent value="transactions">
        <TransactionsTable transactions={transactions} />
      </TabsContent>

      <TabsContent value="audit">
        <AuditTable auditLog={auditLog} />
      </TabsContent>
    </Tabs>
  );
}

const CollapsibleSection = React.memo(function CollapsibleSection({
  title,
  sectionKey,
  open,
  onToggle,
  children,
}: {
  title: string;
  sectionKey: string;
  open: boolean;
  onToggle: (key: string) => void;
  children: React.ReactNode;
}) {
  return (
    <Collapsible open={open} onOpenChange={() => onToggle(sectionKey)}>
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors">
        <ChevronDown
          className={`size-4 transition-transform ${open ? "" : "-rotate-90"}`}
        />
        {title}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2">{children}</CollapsibleContent>
    </Collapsible>
  );
});

const UserHeaderStrip = React.memo(function UserHeaderStrip({
  user,
  isAdmin,
  counts,
}: {
  user: UserDetail["user"];
  isAdmin: boolean;
  counts: UserDetail["counts"];
}) {
  const [reason, setReason] = useState("");
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const [roleChangeOpen, setRoleChangeOpen] = useState(false);
  const [pendingRole, setPendingRole] = useState<string | null>(null);
  const [roleTotpCode, setRoleTotpCode] = useState("");

  const statusKey = user.isBanned
    ? "banned"
    : user.isLocked
      ? "locked"
      : "active";
  const statusLabel = user.isBanned
    ? "Banned"
    : user.isLocked
      ? "Locked"
      : "Active";

  return (
    <div className="rounded-lg border bg-card p-4">
      {/* Top row: avatar, name, badges, actions */}
      <div className="flex items-center gap-4">
        <div className="size-12 shrink-0 rounded-full bg-muted overflow-hidden">
          {user.image ? (
            <img src={user.image} alt="" className="size-full object-cover" />
          ) : (
            <div className="size-full flex items-center justify-center text-lg font-bold text-muted-foreground">
              {(user.username ?? user.email ?? "?")[0].toUpperCase()}
            </div>
          )}
        </div>

        <div className="min-w-0">
          <p className="text-lg font-semibold truncate leading-tight">
            {user.displayUsername ?? user.username ?? user.name ?? "—"}
          </p>
          <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <span className="truncate">{user.email}</span>
            {user.emailVerified && (
              <Badge
                variant="outline"
                className="shrink-0 text-[10px] bg-green-500/15 text-green-600 dark:text-green-400 px-1 py-0"
              >
                verified
              </Badge>
            )}
          </div>
          {/* Deposit / withdrawal activity counts — surfaced here so a
              reviewer sees how often this user has actually moved money
              without opening the transactions tab. */}
          <div className="mt-1 flex items-center gap-4 text-xs text-muted-foreground">
            <span>
              Deposits:{" "}
              <span className="font-semibold tabular-nums text-foreground">
                {counts.deposits}
              </span>
            </span>
            <span>
              Withdrawals:{" "}
              <span className="font-semibold tabular-nums text-foreground">
                {counts.withdrawals}
              </span>
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 ml-auto shrink-0">
          {isAdmin ? (
            <>
              <Select
                value={user.role}
                onValueChange={(v) => {
                  if (!v || v === user.role) return;
                  setPendingRole(v);
                  setRoleTotpCode("");
                  setRoleChangeOpen(true);
                }}
                disabled={isPending}
              >
                <SelectTrigger className="w-[120px] h-7">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["user", "support", "admin", "creator"].map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Dialog open={roleChangeOpen} onOpenChange={setRoleChangeOpen}>
                <DialogContent className="sm:max-w-sm">
                  <DialogHeader>
                    <DialogTitle>Confirm Role Change</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-3 py-2">
                    <p className="text-sm text-muted-foreground">
                      Change role to{" "}
                      <span className="font-medium text-foreground">
                        {pendingRole}
                      </span>
                      . Enter your 2FA code to confirm.
                    </p>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">
                        2FA Code
                      </Label>
                      <Input
                        type="text"
                        inputMode="numeric"
                        placeholder="Enter your 6-digit code"
                        value={roleTotpCode}
                        onChange={(e) => setRoleTotpCode(e.target.value)}
                        maxLength={6}
                        autoComplete="one-time-code"
                      />
                    </div>
                  </div>
                  <DialogFooter>
                    <Button
                      size="sm"
                      className="w-full"
                      disabled={isPending || !roleTotpCode.trim()}
                      onClick={() => {
                        if (!pendingRole) return;
                        startTransition(async () => {
                          try {
                            await changeRole(
                              user.id,
                              pendingRole,
                              roleTotpCode.trim(),
                            );
                            toast.success("Role updated");
                            setRoleChangeOpen(false);
                            router.refresh();
                          } catch (e) {
                            toast.error(
                              e instanceof Error
                                ? e.message
                                : "Failed to change role",
                            );
                          }
                        });
                      }}
                    >
                      {isPending ? "Updating..." : "Confirm"}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </>
          ) : (
            <Badge variant="outline" className={ROLE_COLORS[user.role]}>
              {user.role}
            </Badge>
          )}
          <Badge variant="outline" className={USER_STATUS_COLORS[statusKey]}>
            {statusLabel}
          </Badge>
          <Badge
            variant="outline"
            className={
              user.twoFactorEnabled
                ? "bg-green-500/15 text-green-600 dark:text-green-400"
                : "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400"
            }
          >
            2FA {user.twoFactorEnabled ? "On" : "Off"}
          </Badge>

          <div className="w-px h-6 bg-border mx-1" />

          {!user.isBanned ? (
            <AlertDialog>
              <AlertDialogTrigger
                className={buttonVariants({
                  variant: "destructive",
                  size: "sm",
                })}
              >
                Ban
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    Ban {user.username ?? user.email}?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    This will ban the user and terminate all their sessions.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <Textarea
                  placeholder="Ban reason..."
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    disabled={isPending || !reason.trim()}
                    onClick={() => {
                      startTransition(async () => {
                        await banUser(user.id, reason);
                        toast.success("User banned");
                        setReason("");
                        router.refresh();
                      });
                    }}
                  >
                    Ban
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={isPending}
              onClick={() => {
                startTransition(async () => {
                  await unbanUser(user.id);
                  toast.success("User unbanned");
                  router.refresh();
                });
              }}
            >
              Unban
            </Button>
          )}
          {!user.isLocked ? (
            <AlertDialog>
              <AlertDialogTrigger
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                Lock
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    Lock {user.username ?? user.email}?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    This will lock the user&apos;s account.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <Textarea
                  placeholder="Lock reason..."
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    disabled={isPending || !reason.trim()}
                    onClick={() => {
                      startTransition(async () => {
                        await lockUser(user.id, reason);
                        toast.success("User locked");
                        setReason("");
                        router.refresh();
                      });
                    }}
                  >
                    Lock
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={isPending}
              onClick={() => {
                startTransition(async () => {
                  await unlockUser(user.id);
                  toast.success("User unlocked");
                  router.refresh();
                });
              }}
            >
              Unlock
            </Button>
          )}

          {isAdmin && <DeleteUserDialog user={user} isPending={isPending} />}
        </div>
      </div>

      {/* Bottom row: meta details */}
      <div className="flex items-center gap-3 mt-2 ml-16 text-xs text-muted-foreground">
        <span className="font-mono">{user.id}</span>
        <span>·</span>
        <span>{user.country ?? "Unknown"}</span>
        <span>·</span>
        <span>Joined {formatRelative(user.createdAt)}</span>
      </div>

      {/* Discord */}
      <div className="mt-3 ml-16">
        {user.discord ? (
          <div className="inline-flex items-center gap-2 rounded-md border border-indigo-500/20 bg-indigo-500/[0.05] px-2.5 py-1.5 text-xs">
            <svg
              viewBox="0 0 24 24"
              fill="currentColor"
              className="size-3.5 text-indigo-400"
            >
              <path d="M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.331c-1.183 0-2.157-1.085-2.157-2.42 0-1.333.956-2.418 2.157-2.418 1.21 0 2.176 1.094 2.157 2.418 0 1.335-.956 2.42-2.157 2.42zm7.974 0c-1.183 0-2.157-1.085-2.157-2.42 0-1.333.955-2.418 2.157-2.418 1.21 0 2.176 1.094 2.157 2.418 0 1.335-.946 2.42-2.157 2.42z" />
            </svg>
            <span className="font-medium text-indigo-300">Discord</span>
            <a
              href={`https://discord.com/users/${user.discord.id}`}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-muted-foreground hover:text-foreground hover:underline"
            >
              {user.discord.id}
            </a>
            {user.discord.linkedAt && (
              <span className="text-muted-foreground">
                · linked {formatRelative(user.discord.linkedAt)}
              </span>
            )}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground italic">
            Discord not linked
          </div>
        )}
      </div>
    </div>
  );
});

function DeleteUserDialog({
  user,
  isPending: parentPending,
}: {
  user: UserDetail["user"];
  isPending: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const username = user.username ?? user.email ?? user.id.slice(0, 8);
  const isConfirmed = confirm === username;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) {
          setConfirm("");
          setTotpCode("");
        }
      }}
    >
      <DialogTrigger
        render={
          <Button variant="destructive" size="sm" disabled={parentPending} />
        }
      >
        Delete
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-red-400">
            Delete User Permanently
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            This will{" "}
            <span className="font-semibold text-red-400">
              permanently delete
            </span>{" "}
            <span className="font-semibold text-foreground">{username}</span>{" "}
            and all their data (balances, inventory, transactions, sessions).
            This cannot be undone.
          </p>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              Type{" "}
              <span className="font-mono font-semibold text-foreground">
                {username}
              </span>{" "}
              to confirm
            </Label>
            <Input
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder={username}
              autoComplete="off"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">2FA Code</Label>
            <Input
              type="text"
              inputMode="numeric"
              placeholder="Enter your 6-digit code"
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value)}
              maxLength={6}
              autoComplete="one-time-code"
            />
          </div>
          <Button
            variant="destructive"
            className="w-full"
            disabled={!isConfirmed || !totpCode.trim() || isPending}
            onClick={() => {
              startTransition(async () => {
                try {
                  await deleteUser(user.id, totpCode.trim());
                  toast.success("User deleted");
                  router.push("/users");
                } catch (e) {
                  toast.error(
                    e instanceof Error ? e.message : "Failed to delete user",
                  );
                }
              });
            }}
          >
            {isPending ? "Deleting..." : "Delete User Permanently"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function BalanceAdjustDialog({
  userId,
  open,
  onOpenChange,
}: {
  userId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function handleAdjust() {
    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || !reason.trim()) {
      toast.error("Please enter a valid amount and reason");
      return;
    }
    if (!totpCode.trim()) {
      toast.error("Please enter your 2FA code");
      return;
    }
    startTransition(async () => {
      try {
        await adjustBalance({
          userId,
          amount: numAmount,
          reason,
          totpCode: totpCode.trim(),
        });
        toast.success("Balance adjusted");
        setAmount("");
        setReason("");
        setTotpCode("");
        onOpenChange(false);
        router.refresh();
      } catch (e) {
        toast.error(
          e instanceof Error ? e.message : "Failed to adjust balance",
        );
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Adjust Balance</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Amount</Label>
            <Input
              type="number"
              placeholder="Amount (+/-)"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Reason</Label>
            <Textarea
              placeholder="Reason..."
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">2FA Code</Label>
            <Input
              type="text"
              inputMode="numeric"
              placeholder="Enter your 6-digit code"
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value)}
              maxLength={6}
              autoComplete="one-time-code"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            size="sm"
            onClick={handleAdjust}
            disabled={isPending || !totpCode.trim()}
            className="w-full"
          >
            {isPending ? "Adjusting..." : "Apply Adjustment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function XpAdjustDialog({
  userId,
  open,
  onOpenChange,
}: {
  userId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function handleAdjust() {
    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || !reason.trim()) {
      toast.error("Please enter a valid amount and reason");
      return;
    }
    startTransition(async () => {
      try {
        await adjustXp({ userId, amount: numAmount, reason });
        toast.success("XP adjusted");
        setAmount("");
        setReason("");
        onOpenChange(false);
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to adjust XP");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Adjust XP</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Amount</Label>
            <Input
              type="number"
              placeholder="Amount (+/-)"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Reason</Label>
            <Textarea
              placeholder="Reason..."
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            size="sm"
            onClick={handleAdjust}
            disabled={isPending}
            className="w-full"
          >
            {isPending ? "Adjusting..." : "Apply Adjustment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const BalanceSummaryCard = React.memo(function BalanceSummaryCard({
  balances,
  userId,
  isAdmin,
}: {
  balances: UserDetail["balances"];
  userId: string;
  isAdmin: boolean;
}) {
  const [adjustOpen, setAdjustOpen] = useState(false);

  if (!balances) return null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-sm font-medium">Balances</CardTitle>
        {isAdmin && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => setAdjustOpen(true)}
          >
            Adjust
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Available = balance + inventory + vouchers */}
        <div className="pb-2 border-b">
          <div className="flex items-baseline justify-between">
            <span className="text-sm text-muted-foreground">Available</span>
            <span className="text-2xl font-bold tabular-nums">
              {formatCurrency(
                balances.availableBalance +
                  balances.inventoryValue +
                  balances.vouchersValue,
              )}
            </span>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-md border bg-muted/30 px-2.5 py-1.5">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Balance
              </div>
              <div className="font-semibold tabular-nums">
                {formatCurrency(balances.availableBalance)}
              </div>
            </div>
            <div className="rounded-md border bg-muted/30 px-2.5 py-1.5">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Inventory
              </div>
              <div className="font-semibold tabular-nums">
                {formatCurrency(
                  balances.inventoryValue + balances.vouchersValue,
                )}
              </div>
            </div>
          </div>
        </div>
        <InfoRow
          label="Locked"
          value={formatCurrency(balances.lockedBalance)}
        />
        {balances.unlockAt && (
          <InfoRow
            label="Unlock At"
            value={formatDateTime(balances.unlockAt)}
          />
        )}
        <InfoRow
          label="Deposited"
          value={formatCurrency(balances.totalDeposited)}
        />
        <InfoRow
          label="Withdrawn"
          value={formatCurrency(balances.totalWithdrawn)}
        />
        {(() => {
          // Platform perspective: positive = we earn, negative = we lose
          const platformPnl =
            balances.totalDeposited -
            balances.totalWithdrawn -
            balances.availableBalance -
            balances.lockedBalance -
            balances.inventoryValue -
            balances.vouchersValue;
          const cls =
            platformPnl > 0
              ? "text-emerald-400"
              : platformPnl < 0
                ? "text-rose-400"
                : "text-foreground";
          return (
            <div className="flex items-center justify-between border-t pt-2">
              <span className="text-sm text-muted-foreground">P&L</span>
              <span className={`font-semibold tabular-nums ${cls}`}>
                {platformPnl >= 0 ? "+" : ""}
                {formatCurrency(platformPnl)}
              </span>
            </div>
          );
        })()}
        <InfoRow
          label="Wagered"
          value={formatCurrency(balances.totalWagered)}
        />
        <InfoRow
          label="↳ Packs"
          value={formatCurrency(balances.packsWagered)}
        />
        <InfoRow
          label="↳ Battles"
          value={formatCurrency(balances.battlesWagered)}
        />
        <InfoRow label="Won" value={formatCurrency(balances.totalWon)} />
      </CardContent>
      <BalanceAdjustDialog
        userId={userId}
        open={adjustOpen}
        onOpenChange={setAdjustOpen}
      />
    </Card>
  );
});

const GAMING_TX_TYPES = [
  "pack_opening",
  "battle_bet",
  "battle_sponsorship",
  "battle_refund",
  "voucher_redeemed",
] as const;
const FINANCIAL_TX_TYPES = [
  "deposit",
  "deposit_bonus",
  "admin_balance_adjustment",
  "card_withdrawal",
  "withdrawal_shipping_fee",
  "rakeback_claim",
  "balance_reward_claim",
  "affiliate_claim",
  "promo_code_redeemed",
  "gift_card_redeemed",
  "rain_win",
  "race_prize",
] as const;
const CARD_SALE_TX_TYPES = ["card_sale", "reward_card_sale"] as const;
const EXCHANGE_TX_TYPES = [
  "card_exchange",
  "exchange_excess_to_voucher",
  "exchange_excess_credit",
  "battle_excess_to_voucher",
  "voucher_exchange",
] as const;

const CategoryTransactionsTable = React.memo(
  function CategoryTransactionsTable({
    title,
    userId,
    types,
    initialTx,
    showCardsValue = false,
    cardWithdrawals,
  }: {
    title: string;
    userId: string;
    types: readonly string[];
    initialTx: PaginatedTransactions;
    showCardsValue?: boolean;
    cardWithdrawals?: UserDetail["cardWithdrawals"];
  }) {
    const [txData, setTxData] = useState(initialTx);
    const [typeFilter, setTypeFilter] = useState("all");
    const [statusFilter, setStatusFilter] = useState("all");
    const [dateFrom, setDateFrom] = useState("");
    const [dateTo, setDateTo] = useState("");
    const [selectedTx, setSelectedTx] = useState<Transaction | null>(null);
    const [isPending, startTransition] = useTransition();
    const [currentPerPage, setCurrentPerPage] = useState(initialTx.perPage);

    function buildFilters(overrides?: {
      type?: string;
      status?: string;
      from?: string;
      to?: string;
    }) {
      const tf = overrides?.type ?? typeFilter;
      const sf = overrides?.status ?? statusFilter;
      const df = overrides?.from ?? dateFrom;
      const dt = overrides?.to ?? dateTo;
      return {
        type: tf !== "all" ? tf : undefined,
        types: tf === "all" ? [...types] : undefined,
        status: sf !== "all" ? sf : undefined,
        dateFrom: df || undefined,
        dateTo: dt || undefined,
      };
    }

    function load(
      newPage: number,
      newPerPage?: number,
      filterOverrides?: {
        type?: string;
        status?: string;
        from?: string;
        to?: string;
      },
    ) {
      const pp = newPerPage ?? currentPerPage;
      if (newPerPage) setCurrentPerPage(newPerPage);
      startTransition(async () => {
        const result = await fetchUserTransactions(
          userId,
          newPage,
          pp,
          buildFilters(filterOverrides),
        );
        setTxData(result);
      });
    }

    function handleTypeChange(value: string) {
      setTypeFilter(value);
      load(1, undefined, { type: value });
    }

    function handleStatusChange(value: string) {
      setStatusFilter(value);
      load(1, undefined, { status: value });
    }

    function handleFromChange(value: string) {
      setDateFrom(value);
      load(1, undefined, { from: value });
    }

    function handleToChange(value: string) {
      setDateTo(value);
      load(1, undefined, { to: value });
    }

    const hasFilters =
      typeFilter !== "all" || statusFilter !== "all" || dateFrom || dateTo;

    function clearFilters() {
      setTypeFilter("all");
      setStatusFilter("all");
      setDateFrom("");
      setDateTo("");
      load(1, undefined, { type: "all", status: "all", from: "", to: "" });
    }

    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">{title}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-start gap-3">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Type</Label>
              <Select
                value={typeFilter}
                onValueChange={(v) => v && handleTypeChange(v)}
              >
                <SelectTrigger className="h-8 w-[200px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All types</SelectItem>
                  {types.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t.replace(/_/g, " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Status</Label>
              <Select
                value={statusFilter}
                onValueChange={(v) => v && handleStatusChange(v)}
              >
                <SelectTrigger className="h-8 w-[130px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TX_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s === "all" ? "All statuses" : s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">From</Label>
              <Input
                type="date"
                className="h-8 w-[150px]"
                value={dateFrom}
                onChange={(e) => handleFromChange(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">To</Label>
              <Input
                type="date"
                className="h-8 w-[150px]"
                value={dateTo}
                onChange={(e) => handleToChange(e.target.value)}
              />
            </div>
            {hasFilters && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8"
                onClick={clearFilters}
              >
                <X className="size-3" />
              </Button>
            )}
            {isPending && (
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            )}
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Amount</TableHead>
                {showCardsValue && <TableHead>Cards Value</TableHead>}
                {showCardsValue && <TableHead>House Profit</TableHead>}
                {showCardsValue && <TableHead>House Edge</TableHead>}
                <TableHead>Before</TableHead>
                <TableHead>After</TableHead>
                <TableHead>Inventory</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {txData.data.map((t) => (
                <TableRow key={t.id}>
                  <TableCell>
                    <button
                      onClick={() => setSelectedTx(t)}
                      className="font-mono text-xs text-blue-400 hover:underline"
                    >
                      {t.id.slice(0, 8)}...
                    </button>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="font-mono text-xs">
                      {t.type}
                    </Badge>
                  </TableCell>
                  <TableCell
                    className={
                      t.balanceAfter >= t.balanceBefore
                        ? "text-green-400"
                        : "text-red-400"
                    }
                  >
                    {t.balanceAfter >= t.balanceBefore ? "+" : "-"}
                    {formatCurrency(t.amount)}
                  </TableCell>
                  {showCardsValue &&
                    (() => {
                      const isBattle =
                        t.type === "battle_bet" ||
                        t.type === "battle_sponsorship";
                      const cv = t.cardsValue ?? (isBattle ? 0 : null);
                      return (
                        <>
                          <TableCell className="tabular-nums">
                            {cv != null ? formatCurrency(cv) : "—"}
                          </TableCell>
                          <TableCell className="tabular-nums">
                            {cv != null
                              ? (() => {
                                  const profit = t.amount - cv;
                                  return (
                                    <span
                                      className={
                                        profit > 0
                                          ? "text-green-400"
                                          : profit < 0
                                            ? "text-red-400"
                                            : "text-muted-foreground"
                                      }
                                    >
                                      {profit > 0 ? "+" : ""}
                                      {formatCurrency(profit)}
                                    </span>
                                  );
                                })()
                              : "—"}
                          </TableCell>
                          <TableCell className="tabular-nums text-muted-foreground">
                            {cv != null && t.amount > 0
                              ? (() => {
                                  const edge =
                                    ((t.amount - cv) / t.amount) * 100;
                                  return `${edge.toFixed(1)}%`;
                                })()
                              : "—"}
                          </TableCell>
                        </>
                      );
                    })()}
                  <TableCell className="text-muted-foreground">
                    {formatCurrency(t.balanceBefore)}
                  </TableCell>
                  <TableCell>{formatCurrency(t.balanceAfter)}</TableCell>
                  <TableCell className="text-muted-foreground tabular-nums">
                    {formatCurrency(t.inventoryValue)}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={STATUS_COLORS[t.status] ?? ""}
                    >
                      {t.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-[250px] text-xs text-muted-foreground">
                    {t.packName ? (
                      <Link
                        href={`/packs/${t.packId}`}
                        className="text-blue-400 hover:underline truncate block"
                      >
                        {t.packName}
                      </Link>
                    ) : t.soldCard ? (
                      <span className="truncate block">
                        Sold: {t.soldCard.name}
                      </span>
                    ) : (
                      <span className="truncate block">{t.description}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatRelative(t.createdAt)}
                  </TableCell>
                </TableRow>
              ))}
              {txData.data.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={showCardsValue ? 11 : 9}
                    className="text-center text-muted-foreground"
                  >
                    No transactions
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>

          <TransactionDetailModal
            transaction={selectedTx}
            onClose={() => setSelectedTx(null)}
          />
          {txData.totalPages > 0 && (
            <div className="flex items-center justify-between py-4">
              <p className="text-sm text-muted-foreground">
                {txData.total} transaction{txData.total !== 1 ? "s" : ""}
              </p>
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">Rows</span>
                  <Select
                    value={String(currentPerPage)}
                    onValueChange={(v) => v && load(1, Number(v))}
                  >
                    <SelectTrigger className="h-8 w-[70px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[10, 20, 50, 100].map((n) => (
                        <SelectItem key={n} value={String(n)}>
                          {n}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <span className="text-sm text-muted-foreground">
                  Page {txData.page} of {txData.totalPages}
                </span>
                <div className="flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-8"
                    onClick={() => load(1)}
                    disabled={txData.page <= 1 || isPending}
                  >
                    <ChevronsLeft className="size-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-8"
                    onClick={() => load(txData.page - 1)}
                    disabled={txData.page <= 1 || isPending}
                  >
                    <ChevronLeft className="size-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-8"
                    onClick={() => load(txData.page + 1)}
                    disabled={txData.page >= txData.totalPages || isPending}
                  >
                    <ChevronRight className="size-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-8"
                    onClick={() => load(txData.totalPages)}
                    disabled={txData.page >= txData.totalPages || isPending}
                  >
                    <ChevronsRight className="size-4" />
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* Card Withdrawals */}
          {cardWithdrawals && cardWithdrawals.length > 0 && (
            <CardWithdrawalsSubTable withdrawals={cardWithdrawals} />
          )}
        </CardContent>
      </Card>
    );
  },
);

const CW_STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400",
  processing: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  shipped: "bg-purple-500/15 text-purple-600 dark:text-purple-400",
  completed: "bg-green-500/15 text-green-600 dark:text-green-400",
  failed: "bg-red-500/15 text-red-600 dark:text-red-400",
  cancelled: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400",
};

function CardWithdrawalsSubTable({
  withdrawals,
}: {
  withdrawals: UserDetail["cardWithdrawals"];
}) {
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(10);

  const totalPages = Math.max(1, Math.ceil(withdrawals.length / perPage));
  const paginated = withdrawals.slice((page - 1) * perPage, page * perPage);

  function changePage(p: number) {
    setPage(Math.max(1, Math.min(p, totalPages)));
  }

  function changePerPage(pp: number) {
    setPerPage(pp);
    setPage(1);
  }

  return (
    <div className="border-t pt-4">
      <p className="text-xs font-medium text-muted-foreground mb-3">
        Card Withdrawals ({withdrawals.length})
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>ID</TableHead>
            <TableHead>Method</TableHead>
            <TableHead>Value</TableHead>
            <TableHead>Shipping</TableHead>
            <TableHead>Tracking</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Date</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {paginated.map((w) => (
            <TableRow
              key={w.id}
              className="cursor-pointer hover:bg-muted/50"
              onClick={() => window.open(`/withdrawals/${w.id}`, "_blank")}
            >
              <TableCell>
                <span className="font-mono text-xs text-blue-400">
                  {w.id.slice(0, 8)}…
                </span>
              </TableCell>
              <TableCell className="text-xs">
                {w.method.replace(/_/g, " ")}
              </TableCell>
              <TableCell className="text-xs">
                {formatCurrency(w.totalValueUsd)}
              </TableCell>
              <TableCell className="text-xs">
                {w.shippingFeeUsd != null
                  ? formatCurrency(w.shippingFeeUsd)
                  : "-"}
              </TableCell>
              <TableCell className="text-xs font-mono">
                {w.trackingNumber ?? "-"}
              </TableCell>
              <TableCell>
                <Badge
                  variant="outline"
                  className={CW_STATUS_COLORS[w.status] ?? ""}
                >
                  {w.status}
                </Badge>
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {formatRelative(w.requestedAt)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {totalPages > 0 && (
        <div className="flex items-center justify-between py-4">
          <p className="text-sm text-muted-foreground">
            {withdrawals.length} withdrawal{withdrawals.length !== 1 ? "s" : ""}
          </p>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Rows</span>
              <Select
                value={String(perPage)}
                onValueChange={(v) => v && changePerPage(Number(v))}
              >
                <SelectTrigger className="h-8 w-[70px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[10, 20, 50].map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <span className="text-sm text-muted-foreground">
              Page {page} of {totalPages}
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="icon"
                className="size-8"
                onClick={() => changePage(1)}
                disabled={page <= 1}
              >
                <ChevronsLeft className="size-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="size-8"
                onClick={() => changePage(page - 1)}
                disabled={page <= 1}
              >
                <ChevronLeft className="size-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="size-8"
                onClick={() => changePage(page + 1)}
                disabled={page >= totalPages}
              >
                <ChevronRight className="size-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="size-8"
                onClick={() => changePage(totalPages)}
                disabled={page >= totalPages}
              >
                <ChevronsRight className="size-4" />
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Statistics: merges Platform P&L, Activity, and Rewards into a single
 * Admin-focused info panel. The P&L is the hero (bordered, big, colored)
 * because fraud/moderation reviewers need to spot red flags immediately.
 * Everything else lives in dense subsections underneath so support can
 * still answer deep questions without jumping between cards.
 */
const PnlCard = React.memo(function PnlCard({
  pnlBreakdown: p,
  balances,
}: {
  pnlBreakdown: PnlBreakdown;
  balances: UserDetail["balances"];
}) {
  // Platform P&L = deposited − withdrawn − balance − locked − inventory
  // This already includes ALL effects (bonuses, rakeback etc. flow through
  // balance — when given they increase it, when wagered away they decrease it).
  // Costs below are informational only, NOT subtracted again.
  const platformPnl = balances
    ? balances.totalDeposited -
      balances.totalWithdrawn -
      balances.availableBalance -
      balances.lockedBalance -
      balances.inventoryValue -
      balances.vouchersValue
    : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Platform P&L</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* P&L header */}
        <div className="pb-2 border-b">
          <div className="flex items-baseline gap-3">
            <span className="text-sm text-muted-foreground">P&L</span>
            <span
              className={`text-2xl font-bold tabular-nums ${platformPnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}
            >
              {platformPnl >= 0 ? "+" : ""}
              {formatCurrency(platformPnl)}
            </span>
          </div>
          {balances && (
            <div className="mt-1 text-[10px] text-muted-foreground">
              Deposited {formatCurrency(balances.totalDeposited)} − Withdrawn{" "}
              {formatCurrency(balances.totalWithdrawn)} − Balance{" "}
              {formatCurrency(
                balances.availableBalance + balances.lockedBalance,
              )}{" "}
              − Inventory {formatCurrency(balances.inventoryValue)} − Vouchers{" "}
              {formatCurrency(balances.vouchersValue)}
            </div>
          )}
        </div>

        {/* Cost breakdown — supplementary detail */}
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground pt-1">
          Costs Given (included in P&L)
        </p>
        <InfoRow
          label="↳ Bonuses & Promos"
          value={<PnlValue value={-p.bonusesCost} />}
        />
        <InfoRow
          label="↳ Rakeback"
          value={<PnlValue value={-p.rakebackCost} />}
        />
        <InfoRow
          label="↳ Affiliate"
          value={<PnlValue value={-p.affiliateCost} />}
        />
        <div className="group relative">
          <InfoRow label="↳ Other" value={<PnlValue value={-p.otherCosts} />} />
          {p.otherCosts !== 0 && (
            <div className="invisible group-hover:visible absolute left-0 bottom-full mb-1 z-50 w-64 rounded-md border bg-popover p-3 text-popover-foreground shadow-md">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                Other Costs Breakdown
              </p>
              <div className="space-y-1.5">
                {(
                  [
                    ["Rain Win", p.otherCostsDetail.rainWin],
                    ["Race Prize", p.otherCostsDetail.racePrize],
                    ["Balance Reward", p.otherCostsDetail.balanceRewardClaim],
                    ["Creator Tip", p.otherCostsDetail.creatorTip],
                    ["Voucher Redeemed", p.otherCostsDetail.voucherRedeemed],
                    ["Voucher Exchange", p.otherCostsDetail.voucherExchange],
                    [
                      "Exchange Excess Credit",
                      p.otherCostsDetail.exchangeExcessCredit,
                    ],
                    [
                      "Exchange → Voucher",
                      p.otherCostsDetail.exchangeExcessToVoucher,
                    ],
                    [
                      "Battle → Voucher",
                      p.otherCostsDetail.battleExcessToVoucher,
                    ],
                  ] as [string, number][]
                )
                  .filter(([, v]) => v !== 0)
                  .map(([label, value]) => (
                    <div
                      key={label}
                      className="flex items-center justify-between text-xs"
                    >
                      <span className="text-muted-foreground">{label}</span>
                      <PnlValue value={-value} />
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
});

const ActivityStatsCard = React.memo(function ActivityStatsCard({
  statistics,
  balances,
  inventoryCount,
  bonusPoints,
  userId,
  isAdmin,
}: {
  statistics: UserDetail["statistics"];
  balances: UserDetail["balances"];
  inventoryCount: number;
  bonusPoints: number;
  userId: string;
  isAdmin: boolean;
}) {
  const [xpAdjustOpen, setXpAdjustOpen] = useState(false);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-sm font-medium">Activity</CardTitle>
        {isAdmin && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => setXpAdjustOpen(true)}
          >
            Adjust XP
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1 pb-2 border-b">
          <div className="flex items-baseline gap-3">
            <span className="text-sm text-muted-foreground">Level</span>
            <span className="text-2xl font-bold tabular-nums">
              {statistics?.level ?? 0}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">XP</span>
            <span className="text-sm tabular-nums">{statistics?.xp ?? 0}</span>
          </div>
          {balances &&
            (() => {
              const wagerLoss = balances.totalWagered - balances.totalWon;
              return (
                <div className="flex items-center gap-3">
                  <span className="text-xs text-muted-foreground">
                    Wager Loss
                  </span>
                  <span
                    className={`text-sm tabular-nums ${wagerLoss > 0 ? "text-red-400" : wagerLoss < 0 ? "text-green-400" : "text-muted-foreground"}`}
                  >
                    {wagerLoss > 0 ? "-" : wagerLoss < 0 ? "+" : ""}
                    {formatCurrency(Math.abs(wagerLoss))}
                  </span>
                </div>
              );
            })()}
        </div>
        <InfoRow
          label="Packs Opened"
          value={String(statistics?.openedPacks ?? 0)}
        />
        <InfoRow
          label="Battles Played"
          value={String(statistics?.battlesPlayed ?? 0)}
        />
        <InfoRow label="Inventory Items" value={String(inventoryCount)} />
        <InfoRow label="Bonus Points" value={String(bonusPoints)} />
        {statistics && (
          <>
            <div className="border-t pt-2 mt-2" />
            <InfoRow
              label="Wagered Today"
              value={formatCurrency(statistics.currentDayWageredUsd)}
            />
            <InfoRow
              label="Wagered This Week"
              value={formatCurrency(statistics.currentWeekWageredUsd)}
            />
            <InfoRow
              label="Wagered This Month"
              value={formatCurrency(statistics.currentMonthWageredUsd)}
            />
            <InfoRow
              label="Weekly Wager Count"
              value={String(statistics.weeklyWagerCount)}
            />
            <InfoRow
              label="Last Wagered"
              value={
                statistics.lastWageredAt
                  ? formatRelative(statistics.lastWageredAt)
                  : "Never"
              }
            />
            <InfoRow
              label="Profile Private"
              value={statistics.isProfilePrivate ? "Yes" : "No"}
            />
          </>
        )}
      </CardContent>
      <XpAdjustDialog
        userId={userId}
        open={xpAdjustOpen}
        onOpenChange={setXpAdjustOpen}
      />
    </Card>
  );
});

const RewardsCard = React.memo(function RewardsCard({
  rewards,
}: {
  rewards: UserRewards;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Rewards</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="rounded-md border bg-muted/30 px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Open one-time rewards
          </div>
          <div className="text-2xl font-bold tabular-nums">
            {rewards.openOneTimeCount}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-md border bg-muted/30 px-2.5 py-1.5">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Rakeback claimable
            </div>
            <div className="text-lg font-semibold tabular-nums text-emerald-400">
              {formatCurrency(rewards.rakebackClaimableUsd)}
            </div>
          </div>
          <div className="rounded-md border bg-muted/30 px-2.5 py-1.5">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Rakeback claimed
            </div>
            <div className="text-lg font-semibold tabular-nums text-muted-foreground">
              {formatCurrency(rewards.rakebackClaimedUsd)}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
});

const FeatureLocksCard = React.memo(function FeatureLocksCard({
  userId,
  featureLocks,
  isAdmin,
}: {
  userId: string;
  featureLocks: UserDetail["featureLocks"];
  isAdmin: boolean;
}) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const features = [
    {
      key: "locked_withdrawals_crypto",
      label: "Crypto Withdrawals",
      locked: featureLocks?.lockedWithdrawalsCrypto ?? false,
    },
    {
      key: "locked_withdrawals_items",
      label: "Item Withdrawals",
      locked: featureLocks?.lockedWithdrawalsItems ?? false,
    },
    {
      key: "locked_inventory_sales",
      label: "Inventory Sales",
      locked: featureLocks?.lockedInventorySales ?? false,
    },
    {
      key: "locked_exchanges",
      label: "Exchanges",
      locked: featureLocks?.lockedExchanges ?? false,
    },
    {
      key: "locked_openings",
      label: "Openings",
      locked: featureLocks?.lockedOpenings ?? false,
    },
    {
      key: "locked_vault",
      label: "Vault",
      locked: featureLocks?.lockedVault ?? false,
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Feature Locks</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {features.map((f) => (
          <div key={f.key} className="flex items-center justify-between">
            <span className="text-sm">{f.label}</span>
            <div className="flex items-center gap-2">
              <Badge
                variant="outline"
                className={
                  f.locked
                    ? "bg-red-500/15 text-red-600 dark:text-red-400"
                    : "bg-green-500/15 text-green-600 dark:text-green-400"
                }
              >
                {f.locked ? "Locked" : "Open"}
              </Badge>
              {isAdmin && (
                <Switch
                  checked={f.locked}
                  disabled={isPending}
                  onCheckedChange={(checked) => {
                    startTransition(async () => {
                      await toggleFeatureLock(userId, f.key, checked);
                      toast.success(
                        `${f.label} ${checked ? "locked" : "unlocked"}`,
                      );
                      router.refresh();
                    });
                  }}
                />
              )}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
});

const AccountDetailsSection = React.memo(function AccountDetailsSection({
  user,
  shippingAddress,
  vault,
  depositAddresses,
}: {
  user: UserDetail["user"];
  shippingAddress: UserDetail["shippingAddress"];
  vault: UserDetail["vault"];
  depositAddresses: UserDetail["depositAddresses"];
}) {
  return (
    <div className="space-y-6">
      {/* Row 1 — Account | Shipping Address | Vault */}
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {/* Account */}
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            Account
          </p>
          <div className="space-y-2.5">
            <InfoRow label="Providers" value={user.providers.join(", ")} />
            <InfoRow label="API Key" value={user.hasApiKey ? "Yes" : "No"} />
            <InfoRow
              label="Signup IP"
              value={user.signupIp ?? "-"}
              mono
              truncate
            />
            <InfoRow
              label="Location"
              value={
                [user.city, user.state, user.continentCode]
                  .filter(Boolean)
                  .join(", ") || "-"
              }
            />
            <InfoRow
              label="Registered"
              value={formatDateTime(user.createdAt)}
            />
            <InfoRow label="Updated" value={formatDateTime(user.updatedAt)} />
          </div>
        </div>

        {/* Shipping Address */}
        {shippingAddress && (
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
              Shipping Address
            </p>
            <div className="space-y-2.5">
              <InfoRow
                label="Name"
                value={`${shippingAddress.firstName} ${shippingAddress.lastName}`}
              />
              <InfoRow
                label="Phone"
                value={`${shippingAddress.phoneCountryCode} ${shippingAddress.phoneNumber}`}
              />
              <InfoRow
                label="Address"
                value={[
                  shippingAddress.addressLine1,
                  shippingAddress.addressLine2,
                ]
                  .filter(Boolean)
                  .join(", ")}
                truncate
              />
              <InfoRow label="City" value={shippingAddress.city} />
              {shippingAddress.stateProvince && (
                <InfoRow label="State" value={shippingAddress.stateProvince} />
              )}
              <InfoRow label="ZIP" value={shippingAddress.zipCode} />
              <InfoRow label="Country" value={shippingAddress.country} />
            </div>
          </div>
        )}

        {/* Vault */}
        {vault && (
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
              Vault
            </p>
            <div className="space-y-2.5">
              <InfoRow label="ID" value={vault.id} mono truncate />
              <InfoRow label="Name" value={vault.name} />
              {vault.customerRefId && (
                <InfoRow
                  label="Customer Ref"
                  value={vault.customerRefId}
                  mono
                  truncate
                />
              )}
              {vault.fireblocksVaultId && (
                <InfoRow
                  label="Fireblocks Vault"
                  value={vault.fireblocksVaultId}
                  mono
                  truncate
                />
              )}
              <InfoRow
                label="Created"
                value={formatDateTime(vault.createdAt)}
              />
            </div>
          </div>
        )}
      </div>

      {/* Row 2 — Deposit Addresses (full width) */}
      {depositAddresses.length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            Deposit Addresses
          </p>
          <div className="grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
            {depositAddresses.map((da) => (
              <div
                key={da.id}
                className="space-y-1.5 rounded-md border p-2.5 min-w-0"
              >
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-xs shrink-0">
                    {da.assetId}
                  </Badge>
                </div>
                <p className="font-mono text-xs truncate" title={da.address}>
                  {da.address}
                </p>
                {da.tag && (
                  <p className="text-xs text-muted-foreground">
                    Tag: <span className="font-mono">{da.tag}</span>
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
});

const ModerationSection = React.memo(function ModerationSection({
  user,
  mutes,
}: {
  user: UserDetail["user"];
  mutes: UserDetail["mutes"];
}) {
  return (
    <div className="space-y-6">
      {/* Ban/Lock Metadata */}
      {(user.isBanned || user.isLocked) && (
        <div className="space-y-3">
          {user.isBanned && (
            <div className="rounded-md border border-red-500/30 bg-red-500/5 p-3 space-y-2">
              <p className="text-sm font-medium text-red-400">Banned</p>
              {user.bannedReason && (
                <p className="text-xs text-muted-foreground">
                  Reason: {user.bannedReason}
                </p>
              )}
              {user.bannedAt && (
                <p className="text-xs text-muted-foreground">
                  Date: {formatDateTime(user.bannedAt)}
                </p>
              )}
              {user.bannedBy && (
                <p className="text-xs text-muted-foreground">
                  By: {user.bannedBy}
                </p>
              )}
            </div>
          )}
          {user.isLocked && (
            <div className="rounded-md border border-yellow-500/30 bg-yellow-500/5 p-3 space-y-2">
              <p className="text-sm font-medium text-yellow-400">Locked</p>
              {user.lockedReason && (
                <p className="text-xs text-muted-foreground">
                  Reason: {user.lockedReason}
                </p>
              )}
              {user.lockedAt && (
                <p className="text-xs text-muted-foreground">
                  Date: {formatDateTime(user.lockedAt)}
                </p>
              )}
              {user.lockedBy && (
                <p className="text-xs text-muted-foreground">
                  By: {user.lockedBy}
                </p>
              )}
              {user.lockedUntil && (
                <p className="text-xs text-muted-foreground">
                  Until: {formatDateTime(user.lockedUntil)}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Mute History */}
      {mutes.length > 0 && (
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-3">
            Mute History ({mutes.length})
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {mutes.map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="text-xs">
                    {formatDateTime(m.createdAt)}
                  </TableCell>
                  <TableCell className="text-xs">{m.reason ?? "-"}</TableCell>
                  <TableCell className="text-xs">
                    {m.expiresAt ? formatDateTime(m.expiresAt) : "Permanent"}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={
                        m.unmutedAt
                          ? "bg-green-500/15 text-green-600 dark:text-green-400"
                          : "bg-red-500/15 text-red-600 dark:text-red-400"
                      }
                    >
                      {m.unmutedAt ? "Unmuted" : "Active"}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {mutes.length === 0 && !user.isBanned && !user.isLocked && (
        <p className="text-sm text-muted-foreground">No moderation history</p>
      )}
    </div>
  );
});

const TX_TYPES = [
  "all",
  "deposit",
  "pack_opening",
  "battle_bet",
  "battle_sponsorship",
  "battle_refund",
  "card_sale",
  "reward_card_sale",
  "card_exchange",
  "exchange_excess_to_voucher",
  "exchange_excess_credit",
  "battle_excess_to_voucher",
  "voucher_redeemed",
  "voucher_exchange",
  "deposit_bonus",
  "vault_lock",
  "vault_unlock",
  "race_prize",
  "gift_card_redeemed",
  "promo_code_redeemed",
  "rakeback_claim",
  "balance_reward_claim",
  "affiliate_claim",
  "withdrawal_shipping_fee",
  "admin_balance_adjustment",
  "rain_tip",
  "rain_win",
  "creator_tip",
  "waitlist_prize",
  "pack_borrow_to_voucher",
  "card_withdrawal",
] as const;

const TX_STATUSES = ["all", "pending", "completed", "failed"] as const;

const TransactionsTable = React.memo(function TransactionsTable({
  transactions,
}: {
  transactions: PaginatedTransactions;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [selectedTx, setSelectedTx] = useState<Transaction | null>(null);
  const { data, page, totalPages, total, perPage } = transactions;

  const activeType = searchParams.get("txType") ?? "all";
  const activeStatus = searchParams.get("txStatus") ?? "all";
  const activeFrom = searchParams.get("txFrom") ?? "";
  const activeTo = searchParams.get("txTo") ?? "";

  function navigate(newPage: number, newPerPage?: number) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("txPage", String(newPage));
    if (newPerPage) params.set("txPerPage", String(newPerPage));
    router.push(`?${params.toString()}`);
  }

  function setFilter(key: string, value: string | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (value && value !== "all") {
      params.set(key, value);
    } else {
      params.delete(key);
    }
    params.set("txPage", "1");
    router.push(`?${params.toString()}`);
  }

  function clearFilters() {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("txType");
    params.delete("txStatus");
    params.delete("txFrom");
    params.delete("txTo");
    params.set("txPage", "1");
    router.push(`?${params.toString()}`);
  }

  const hasFilters =
    activeType !== "all" || activeStatus !== "all" || activeFrom || activeTo;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Transactions</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-start gap-3">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Type</Label>
            <Select
              value={activeType}
              onValueChange={(v) => setFilter("txType", v)}
            >
              <SelectTrigger className="h-8 w-[200px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TX_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t === "all" ? "All types" : t.replace(/_/g, " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Status</Label>
            <Select
              value={activeStatus}
              onValueChange={(v) => setFilter("txStatus", v)}
            >
              <SelectTrigger className="h-8 w-[130px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TX_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s === "all" ? "All statuses" : s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">From</Label>
            <Input
              type="date"
              className="h-8 w-[150px]"
              value={activeFrom}
              onChange={(e) => setFilter("txFrom", e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">To</Label>
            <Input
              type="date"
              className="h-8 w-[150px]"
              value={activeTo}
              onChange={(e) => setFilter("txTo", e.target.value)}
            />
          </div>
          {hasFilters && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8"
              onClick={clearFilters}
            >
              <X className="size-3" />
            </Button>
          )}
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Amount</TableHead>
              <TableHead>Before</TableHead>
              <TableHead>After</TableHead>
              <TableHead>Inventory</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>Date</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((t) => (
              <TableRow key={t.id}>
                <TableCell>
                  <button
                    onClick={() => setSelectedTx(t)}
                    className="font-mono text-xs text-blue-400 hover:underline"
                  >
                    {t.id.slice(0, 8)}...
                  </button>
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className="font-mono text-xs">
                    {t.type}
                  </Badge>
                </TableCell>
                <TableCell
                  className={
                    t.balanceAfter >= t.balanceBefore
                      ? "text-green-400"
                      : "text-red-400"
                  }
                >
                  {t.balanceAfter >= t.balanceBefore ? "+" : "-"}
                  {formatCurrency(t.amount)}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatCurrency(t.balanceBefore)}
                </TableCell>
                <TableCell>{formatCurrency(t.balanceAfter)}</TableCell>
                <TableCell className="text-muted-foreground tabular-nums">
                  {formatCurrency(t.inventoryValue)}
                </TableCell>
                <TableCell>
                  <Badge
                    variant="outline"
                    className={STATUS_COLORS[t.status] ?? ""}
                  >
                    {t.status}
                  </Badge>
                </TableCell>
                <TableCell className="max-w-[250px] text-xs text-muted-foreground">
                  {t.packName ? (
                    <Link
                      href={`/packs/${t.packId}`}
                      className="text-blue-400 hover:underline truncate block"
                    >
                      {t.packName}
                    </Link>
                  ) : t.soldCard ? (
                    <span className="truncate block">
                      Sold: {t.soldCard.name}
                    </span>
                  ) : (
                    <span className="truncate block">{t.description}</span>
                  )}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {formatRelative(t.createdAt)}
                </TableCell>
              </TableRow>
            ))}
            {data.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={9}
                  className="text-center text-muted-foreground"
                >
                  No transactions
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>

        <TransactionDetailModal
          transaction={selectedTx}
          onClose={() => setSelectedTx(null)}
        />
        {totalPages > 0 && (
          <div className="flex items-center justify-between py-4">
            <p className="text-sm text-muted-foreground">
              {total} transaction{total !== 1 ? "s" : ""}
            </p>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Rows</span>
                <Select
                  value={String(perPage)}
                  onValueChange={(v) => navigate(1, Number(v))}
                >
                  <SelectTrigger className="h-8 w-[70px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[10, 20, 50, 100].map((n) => (
                      <SelectItem key={n} value={String(n)}>
                        {n}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <span className="text-sm text-muted-foreground">
                Page {page} of {totalPages}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="icon"
                  className="size-8"
                  onClick={() => navigate(1)}
                  disabled={page <= 1}
                >
                  <ChevronsLeft className="size-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="size-8"
                  onClick={() => navigate(page - 1)}
                  disabled={page <= 1}
                >
                  <ChevronLeft className="size-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="size-8"
                  onClick={() => navigate(page + 1)}
                  disabled={page >= totalPages}
                >
                  <ChevronRight className="size-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="size-8"
                  onClick={() => navigate(totalPages)}
                  disabled={page >= totalPages}
                >
                  <ChevronsRight className="size-4" />
                </Button>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
});

// Only events the backend actually emits (verified against prod
// audit_events table) plus the synthetic deposit/withdrawal entries
// merged in by getUserAuditLog.
const AUDIT_EVENT_TYPES = [
  "login",
  "logout",
  "register",
  "username_changed",
  "settings_changed",
  "deposit",
  "withdrawal",
  "admin_balance_adjustment",
] as const;

const AuditTable = React.memo(function AuditTable({
  auditLog,
}: {
  auditLog: PaginatedAuditLog;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data, page, totalPages, total, perPage } = auditLog;

  const activeEventType = searchParams.get("auditEventType") ?? "all";

  function navigate(newPage: number, newPerPage?: number) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("auditPage", String(newPage));
    if (newPerPage) params.set("auditPerPage", String(newPerPage));
    router.push(`?${params.toString()}`);
  }

  function setEventType(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value && value !== "all") {
      params.set("auditEventType", value);
    } else {
      params.delete("auditEventType");
    }
    params.set("auditPage", "1");
    router.push(`?${params.toString()}`);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Audit Log</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-start gap-3">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Event Type</Label>
            <Select
              value={activeEventType}
              onValueChange={(v) => v && setEventType(v)}
            >
              <SelectTrigger className="h-8 w-[250px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All events</SelectItem>
                {AUDIT_EVENT_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t.replace(/_/g, " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {activeEventType !== "all" && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 mt-5"
              onClick={() => setEventType("all")}
            >
              <X className="size-3" />
            </Button>
          )}
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Event</TableHead>
              <TableHead>Details</TableHead>
              <TableHead>IP</TableHead>
              <TableHead>Country</TableHead>
              <TableHead>Date</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((e) => {
              const meta = e.metadata as Record<string, unknown> | null;
              let details: React.ReactNode = "-";
              if (e.eventType === "deposit" && meta) {
                details = (
                  <span className="text-emerald-400 tabular-nums">
                    +{formatCurrency(Number(meta.amountUsd ?? 0))}
                    {meta.cryptoAsset ? ` (${meta.cryptoAsset})` : ""}
                  </span>
                );
              } else if (e.eventType === "withdrawal" && meta) {
                details = (
                  <span className="tabular-nums">
                    {formatCurrency(Number(meta.amountUsd ?? 0))}
                    <span className="ml-1 text-muted-foreground">
                      · {String(meta.method ?? "")} ·{" "}
                      {String(meta.status ?? "")}
                    </span>
                  </span>
                );
              } else if (e.eventType === "admin_balance_adjustment" && meta) {
                const amt = Number(meta.amountUsd ?? 0);
                details = (
                  <span className="tabular-nums">
                    <span className={amt >= 0 ? "text-emerald-400" : "text-rose-400"}>
                      {amt >= 0 ? "+" : ""}{formatCurrency(amt)}
                    </span>
                    {typeof meta.description === "string" && meta.description && (
                      <span className="ml-1 text-muted-foreground">
                        · {meta.description}
                      </span>
                    )}
                  </span>
                );
              }
              const badgeColor =
                e.eventType === "deposit"
                  ? "bg-emerald-500/15 text-emerald-400"
                  : e.eventType === "withdrawal"
                    ? "bg-amber-500/15 text-amber-400"
                    : e.eventType === "admin_balance_adjustment"
                      ? "bg-blue-500/15 text-blue-400"
                      : e.eventType.includes("failed") ||
                          e.eventType.includes("banned") ||
                          e.eventType.includes("locked")
                        ? "bg-red-500/15 text-red-400"
                        : "";
              return (
                <TableRow key={e.id}>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={`font-mono text-xs ${badgeColor}`}
                    >
                      {e.eventType.replace(/_/g, " ")}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs">{details}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {e.ip ?? "-"}
                  </TableCell>
                  <TableCell className="text-sm">{e.country ?? "-"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatRelative(e.createdAt)}
                  </TableCell>
                </TableRow>
              );
            })}
            {data.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="text-center text-muted-foreground"
                >
                  No audit events
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        {totalPages > 0 && (
          <div className="flex items-center justify-between py-4">
            <p className="text-sm text-muted-foreground">
              {total} event{total !== 1 ? "s" : ""}
            </p>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Rows</span>
                <Select
                  value={String(perPage)}
                  onValueChange={(v) => navigate(1, Number(v))}
                >
                  <SelectTrigger className="h-8 w-[70px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[10, 20, 50, 100].map((n) => (
                      <SelectItem key={n} value={String(n)}>
                        {n}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <span className="text-sm text-muted-foreground">
                Page {page} of {totalPages}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="icon"
                  className="size-8"
                  onClick={() => navigate(1)}
                  disabled={page <= 1}
                >
                  <ChevronsLeft className="size-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="size-8"
                  onClick={() => navigate(page - 1)}
                  disabled={page <= 1}
                >
                  <ChevronLeft className="size-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="size-8"
                  onClick={() => navigate(page + 1)}
                  disabled={page >= totalPages}
                >
                  <ChevronRight className="size-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="size-8"
                  onClick={() => navigate(totalPages)}
                  disabled={page >= totalPages}
                >
                  <ChevronsRight className="size-4" />
                </Button>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
});

type GameSessionDetails = {
  id: string;
  gameType: string;
  result: string | null;
  betAmount: number;
  pack: { id: string; name: string; imageUrl: string | null } | null;
  items: {
    id: string;
    cardName: string;
    imageUrl: string | null;
    rarity: string | null;
    priceUsd: number;
    valueAtObtained: number;
  }[];
  pfResults: {
    id: string;
    clientSeed: string;
    serverSeedHash: string;
    serverSeed: string | null;
    nonce: number;
    cursor: number;
    ticket: number;
    resultHash: string;
  }[];
  createdAt: string;
};

const RARITY_COLORS: Record<string, string> = {
  common: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400",
  uncommon: "bg-green-500/15 text-green-600 dark:text-green-400",
  rare: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  "ultra rare": "bg-purple-500/15 text-purple-600 dark:text-purple-400",
  "secret rare": "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400",
  legendary: "bg-orange-500/15 text-orange-600 dark:text-orange-400",
  holo: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400",
};

function TransactionDetailModal({
  transaction,
  onClose,
}: {
  transaction: Transaction | null;
  onClose: () => void;
}) {
  const [gameSession, setGameSession] = useState<GameSessionDetails | null>(
    null,
  );
  const [loadingSession, setLoadingSession] = useState(false);

  useEffect(() => {
    if (!transaction?.gameSessionId) {
      setGameSession(null);
      return;
    }
    setLoadingSession(true);
    setGameSession(null);
    getGameSessionDetails(transaction.gameSessionId)
      .then((data) => setGameSession(data))
      .finally(() => setLoadingSession(false));
  }, [transaction?.id, transaction?.gameSessionId]);

  if (!transaction) return null;
  const t = transaction;

  const rows: { label: string; value: React.ReactNode }[] = [
    {
      label: "ID",
      value: <span className="font-mono text-xs break-all">{t.id}</span>,
    },
    {
      label: "Type",
      value: (
        <Badge variant="outline" className="font-mono text-xs">
          {t.type}
        </Badge>
      ),
    },
    {
      label: "Amount",
      value: (
        <span
          className={
            t.balanceAfter >= t.balanceBefore
              ? "text-green-400"
              : "text-red-400"
          }
        >
          {t.balanceAfter >= t.balanceBefore ? "+" : "-"}
          {formatCurrency(t.amount)}
        </span>
      ),
    },
    { label: "Balance Before", value: formatCurrency(t.balanceBefore) },
    { label: "Balance After", value: formatCurrency(t.balanceAfter) },
    { label: "Inventory Value", value: formatCurrency(t.inventoryValue) },
    {
      label: "Status",
      value: (
        <Badge variant="outline" className={STATUS_COLORS[t.status] ?? ""}>
          {t.status}
        </Badge>
      ),
    },
    { label: "Description", value: t.description },
    { label: "Created", value: formatDateTime(t.createdAt) },
    { label: "Updated", value: formatDateTime(t.updatedAt) },
  ];

  if (t.failureReason) {
    rows.push({
      label: "Failure Reason",
      value: <span className="text-red-400">{t.failureReason}</span>,
    });
  }
  if (t.cryptoAsset) {
    rows.push({ label: "Crypto Asset", value: t.cryptoAsset });
  }
  if (t.cryptoAmount != null) {
    rows.push({ label: "Crypto Amount", value: String(t.cryptoAmount) });
  }
  if (t.exchangeRate != null) {
    rows.push({ label: "Exchange Rate", value: String(t.exchangeRate) });
  }
  if (t.blockchainTxHash) {
    rows.push({
      label: "Blockchain TX",
      value: (
        <span className="font-mono text-xs break-all">
          {t.blockchainTxHash}
        </span>
      ),
    });
  }
  if (t.sourceAddress) {
    rows.push({
      label: "Source Address",
      value: (
        <span className="font-mono text-xs break-all">{t.sourceAddress}</span>
      ),
    });
  }
  if (t.destinationAddress) {
    rows.push({
      label: "Destination Address",
      value: (
        <span className="font-mono text-xs break-all">
          {t.destinationAddress}
        </span>
      ),
    });
  }
  if (t.depositAddressId) {
    rows.push({
      label: "Deposit Address ID",
      value: (
        <span className="font-mono text-xs break-all">
          {t.depositAddressId}
        </span>
      ),
    });
  }
  if (t.gameSessionId) {
    rows.push({
      label: "Game Session ID",
      value: (
        <span className="font-mono text-xs break-all">{t.gameSessionId}</span>
      ),
    });
  }
  if (t.fireblocksTxId) {
    rows.push({
      label: "Fireblocks TX ID",
      value: (
        <span className="font-mono text-xs break-all">{t.fireblocksTxId}</span>
      ),
    });
  }
  if (t.externalTxId) {
    rows.push({
      label: "External TX ID",
      value: (
        <span className="font-mono text-xs break-all">{t.externalTxId}</span>
      ),
    });
  }
  if (t.soldCard) {
    rows.push({
      label: "Card Sold",
      value: (
        <div className="flex items-center gap-3 rounded-lg border p-2">
          {t.soldCard.imageUrl ? (
            <img
              src={t.soldCard.imageUrl}
              alt={t.soldCard.name}
              className="h-16 w-auto rounded object-contain"
            />
          ) : (
            <div className="h-16 w-10 rounded bg-muted flex items-center justify-center text-xs text-muted-foreground">
              ?
            </div>
          )}
          <div>
            <p className="text-sm font-medium">{t.soldCard.name}</p>
            {t.soldCard.rarity && (
              <Badge
                variant="outline"
                className={`text-[10px] ${RARITY_COLORS[t.soldCard.rarity.toLowerCase()] ?? ""}`}
              >
                {t.soldCard.rarity}
              </Badge>
            )}
          </div>
        </div>
      ),
    });
  }
  if (t.metadata && typeof t.metadata === "object") {
    const meta = t.metadata as Record<string, unknown>;
    const KNOWN_LABELS: Record<string, string> = {
      source_type: "Source Type",
      inventory_item_id: "Inventory Item",
      card_id: "Card",
      pack_id: "Pack",
      pack_name: "Pack Name",
      promo_code: "Promo Code",
      promo_code_id: "Promo Code",
      gift_card_code: "Gift Card Code",
      gift_card_id: "Gift Card",
      battle_id: "Battle",
      vault_id: "Vault",
      race_id: "Race",
      race_name: "Race Name",
      affiliate_code: "Affiliate Code",
      affiliate_id: "Affiliate",
      amount: "Amount",
      reason: "Reason",
      adjusted_by: "Adjusted By",
      action: "Action",
      bonus_percent: "Bonus %",
      deposit_tx_id: "Deposit TX",
      sender_id: "Sender",
      sender_username: "Sender",
      recipient_id: "Recipient",
      recipient_username: "Recipient",
      creator_id: "Creator",
      creator_username: "Creator",
      tip_amount: "Tip Amount",
      voucher_id: "Voucher",
      voucher_code: "Voucher Code",
      exchange_id: "Exchange",
      origin: "Origin",
      origin_id: "Origin ID",
      origin_type: "Origin Type",
      battle_name: "Battle Name",
      pack_count: "Pack Count",
      cards_count: "Cards Count",
      total_value: "Total Value",
      fee: "Fee",
      fee_percent: "Fee %",
      level: "Level",
      xp: "XP",
      reward_type: "Reward Type",
      reward_id: "Reward",
      reward_name: "Reward Name",
      claim_id: "Claim",
      period: "Period",
      tier: "Tier",
      percentage: "Percentage",
      shipping_fee: "Shipping Fee",
      withdrawal_id: "Withdrawal",
      rain_id: "Rain",
    };

    const knownEntries: { label: string; value: string }[] = [];
    const unknownEntries: Record<string, unknown> = {};

    for (const [key, val] of Object.entries(meta)) {
      if (t.soldCard && key === "inventory_item_id") continue; // already shown as card
      const label = KNOWN_LABELS[key];
      if (label && val != null) {
        knownEntries.push({ label, value: String(val) });
      } else if (val != null) {
        unknownEntries[key] = val;
      }
    }

    for (const entry of knownEntries) {
      rows.push({
        label: entry.label,
        value: (
          <span className="font-mono text-xs break-all">{entry.value}</span>
        ),
      });
    }

    if (Object.keys(unknownEntries).length > 0) {
      rows.push({
        label: "Metadata",
        value: (
          <pre className="font-mono text-xs bg-muted rounded p-2 max-h-[200px] overflow-auto whitespace-pre-wrap break-all">
            {JSON.stringify(unknownEntries, null, 2)}
          </pre>
        ),
      });
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-2xl flex flex-col max-h-[85vh]">
        <DialogHeader>
          <DialogTitle>Transaction Details</DialogTitle>
        </DialogHeader>
        <div className="overflow-y-auto flex-1 -mx-4 px-4 space-y-4">
          <div className="grid grid-cols-2 gap-x-6 gap-y-3">
            {rows.map((row) => (
              <div key={row.label} className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">
                  {row.label}
                </span>
                <div className="text-sm">{row.value}</div>
              </div>
            ))}
          </div>

          {t.gameSessionId && (
            <div className="border-t pt-4 space-y-3">
              {loadingSession ? (
                <p className="text-sm text-muted-foreground text-center py-4">
                  Loading game details...
                </p>
              ) : gameSession ? (
                <>
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium">
                      {gameSession.gameType === "pack"
                        ? "Pack Opening"
                        : "Battle"}{" "}
                      Details
                    </h3>
                    <Badge variant="outline" className="font-mono text-xs">
                      {gameSession.result}
                    </Badge>
                  </div>

                  {gameSession.pack && (
                    <Link
                      href={`/packs/${gameSession.pack.id}`}
                      className="flex items-center gap-4 py-2 group"
                    >
                      {gameSession.pack.imageUrl && (
                        <img
                          src={gameSession.pack.imageUrl}
                          alt={gameSession.pack.name}
                          className="h-20 w-auto rounded-lg object-contain drop-shadow-lg"
                        />
                      )}
                      <div>
                        <p className="text-sm font-semibold text-blue-400 group-hover:underline">
                          {gameSession.pack.name}
                        </p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Bet: {formatCurrency(gameSession.betAmount)}
                        </p>
                      </div>
                    </Link>
                  )}

                  {gameSession.items.length > 0 && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-3">
                        Cards Obtained ({gameSession.items.length})
                      </p>
                      <div className="grid grid-cols-4 gap-4">
                        {gameSession.items.map((item) => (
                          <div
                            key={item.id}
                            className="flex flex-col items-center gap-1.5"
                          >
                            {item.imageUrl ? (
                              <img
                                src={item.imageUrl}
                                alt={item.cardName}
                                className="h-28 w-auto rounded-lg object-contain drop-shadow-md"
                              />
                            ) : (
                              <div className="h-28 w-20 rounded-lg bg-muted/50 flex items-center justify-center text-xs text-muted-foreground">
                                ?
                              </div>
                            )}
                            <p className="text-xs font-medium text-center truncate w-full">
                              {item.cardName}
                            </p>
                            {item.rarity && (
                              <Badge
                                variant="outline"
                                className={`text-[10px] ${RARITY_COLORS[item.rarity.toLowerCase()] ?? ""}`}
                              >
                                {item.rarity}
                              </Badge>
                            )}
                            <p className="text-xs text-muted-foreground">
                              {formatCurrency(item.valueAtObtained)}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {gameSession.pfResults.length > 0 && (
                    <div className="border-t pt-3 space-y-2">
                      <p className="text-xs text-muted-foreground">
                        Provably Fair
                      </p>
                      {gameSession.pfResults.map((pf, i) => (
                        <div
                          key={pf.id}
                          className="rounded-lg border bg-muted/30 p-3 space-y-1.5"
                        >
                          {gameSession.pfResults.length > 1 && (
                            <p className="text-[11px] font-medium text-muted-foreground">
                              Roll #{i + 1}
                            </p>
                          )}
                          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                            <div>
                              <p className="text-[10px] text-muted-foreground">
                                Client Seed
                              </p>
                              <p className="text-[11px] font-mono break-all">
                                {pf.clientSeed}
                              </p>
                            </div>
                            <div>
                              <p className="text-[10px] text-muted-foreground">
                                Server Seed Hash
                              </p>
                              <p className="text-[11px] font-mono break-all">
                                {pf.serverSeedHash}
                              </p>
                            </div>
                            {pf.serverSeed && (
                              <div className="col-span-2">
                                <p className="text-[10px] text-muted-foreground">
                                  Server Seed
                                </p>
                                <p className="text-[11px] font-mono break-all">
                                  {pf.serverSeed}
                                </p>
                              </div>
                            )}
                            <div>
                              <p className="text-[10px] text-muted-foreground">
                                Nonce
                              </p>
                              <p className="text-[11px] font-mono">
                                {pf.nonce}
                              </p>
                            </div>
                            <div>
                              <p className="text-[10px] text-muted-foreground">
                                Ticket
                              </p>
                              <p className="text-[11px] font-mono">
                                {pf.ticket}
                              </p>
                            </div>
                            <div className="col-span-2">
                              <p className="text-[10px] text-muted-foreground">
                                Result Hash
                              </p>
                              <p className="text-[11px] font-mono break-all">
                                {pf.resultHash}
                              </p>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <p className="text-sm text-muted-foreground text-center py-2">
                  Game session not found
                </p>
              )}
            </div>
          )}
        </div>
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  );
}

const balanceChartConfig = {
  balance: {
    label: "Balance",
    color: "var(--color-chart-1)",
  },
} satisfies ChartConfig;

const BALANCE_RANGES = [
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
  { label: "All", days: 0 },
] as const;

const BalanceHistoryChart = React.memo(function BalanceHistoryChart({
  data,
}: {
  data: BalanceHistoryPoint[];
}) {
  const [range, setRange] = useState(30);

  if (data.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Balance History</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground text-center py-8">
            No transaction history
          </p>
        </CardContent>
      </Card>
    );
  }

  const filtered =
    range > 0
      ? (() => {
          const cutoff = new Date();
          cutoff.setDate(cutoff.getDate() - range);
          const cutoffStr = cutoff.toISOString().slice(0, 10);
          return data.filter((d) => d.date >= cutoffStr);
        })()
      : data;

  const chartData = filtered.length > 0 ? filtered : data;
  const tickInterval = Math.max(1, Math.floor(chartData.length / 10));

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-sm font-medium">Balance History</CardTitle>
        <div className="flex items-center gap-1">
          {BALANCE_RANGES.map((r) => (
            <Button
              key={r.label}
              variant={range === r.days ? "default" : "outline"}
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setRange(r.days)}
            >
              {r.label}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        <ChartContainer
          config={balanceChartConfig}
          className="h-[300px] w-full"
        >
          <AreaChart data={chartData} accessibilityLayer>
            <defs>
              <linearGradient id="balanceGradient" x1="0" y1="0" x2="0" y2="1">
                <stop
                  offset="5%"
                  stopColor="var(--color-balance)"
                  stopOpacity={0.3}
                />
                <stop
                  offset="95%"
                  stopColor="var(--color-balance)"
                  stopOpacity={0}
                />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              interval={tickInterval}
              tickFormatter={(v) => v.slice(5)}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              width={70}
              domain={["auto", "auto"]}
              tickFormatter={(v) => {
                if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
                if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
                return `$${v}`;
              }}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  formatter={(value) => `$${Number(value).toFixed(2)}`}
                />
              }
            />
            <Area
              type="monotone"
              dataKey="balance"
              stroke="var(--color-balance)"
              strokeWidth={2}
              fill="url(#balanceGradient)"
            />
          </AreaChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
});

const INVENTORY_RARITY_COLORS: Record<string, string> = {
  common: "bg-zinc-700/90 text-zinc-100",
  uncommon: "bg-green-700/90 text-green-100",
  rare: "bg-blue-700/90 text-blue-100",
  "ultra rare": "bg-purple-700/90 text-purple-100",
  "secret rare": "bg-yellow-600/90 text-yellow-100",
  legendary: "bg-orange-600/90 text-orange-100",
  holo: "bg-cyan-700/90 text-cyan-100",
  secret: "bg-pink-700/90 text-pink-100",
};

const InventoryGrid = React.memo(function InventoryGrid({
  userId,
  initialInventory,
  inventoryValue,
  statusFilter = "owned",
}: {
  userId: string;
  initialInventory: PaginatedInventory;
  inventoryValue: number;
  statusFilter?: string;
}) {
  const [inventory, setInventory] = useState(initialInventory);
  const [loading, setLoading] = useState(false);
  const [rarity, setRarity] = useState("all");
  const [sort, setSort] = useState("newest");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [priceMin, setPriceMin] = useState("");
  const [priceMax, setPriceMax] = useState("");
  const [page, setPage] = useState(1);

  const { data, totalPages, total } = inventory;

  const hasFilters =
    rarity !== "all" ||
    sort !== "newest" ||
    search !== "" ||
    priceMin !== "" ||
    priceMax !== "";

  const load = async (overrides: Record<string, unknown> = {}) => {
    const p = (overrides.page as number) ?? page;
    const filters = {
      rarity:
        ((overrides.rarity as string) ?? rarity) !== "all"
          ? ((overrides.rarity as string) ?? rarity)
          : undefined,
      status: statusFilter,
      search: ((overrides.search as string) ?? search) || undefined,
      sort:
        ((overrides.sort as string) ?? sort) !== "newest"
          ? ((overrides.sort as string) ?? sort)
          : undefined,
      priceMin:
        ((overrides.priceMin as string) ?? priceMin)
          ? Number((overrides.priceMin as string) ?? priceMin)
          : undefined,
      priceMax:
        ((overrides.priceMax as string) ?? priceMax)
          ? Number((overrides.priceMax as string) ?? priceMax)
          : undefined,
    };
    setLoading(true);
    try {
      const result = await fetchInventory(userId, p, 24, filters);
      setInventory(result);
    } finally {
      setLoading(false);
    }
  };

  const updateFilter = (key: string, value: string | null) => {
    const v = value ?? "";
    const updates: Record<string, unknown> = { [key]: v, page: 1 };
    if (key === "rarity") setRarity(v);
    else if (key === "sort") setSort(v);
    else if (key === "search") setSearch(v);
    else if (key === "priceMin") setPriceMin(v);
    else if (key === "priceMax") setPriceMax(v);
    setPage(1);
    load(updates);
  };

  const navigate = (newPage: number) => {
    setPage(newPage);
    load({ page: newPage });
  };

  const clearFilters = () => {
    setRarity("all");

    setSort("newest");
    setSearch("");
    setSearchInput("");
    setPriceMin("");
    setPriceMax("");
    setPage(1);
    load({
      rarity: "all",
      sort: "newest",
      search: "",
      priceMin: "",
      priceMax: "",
      page: 1,
    });
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium">
            {total} items
            {inventoryValue > 0 ? (
              <>
                {" "}
                —{" "}
                <span className="text-muted-foreground">
                  {formatCurrency(inventoryValue)}
                </span>
              </>
            ) : null}
          </CardTitle>
          {totalPages > 1 && (
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="icon"
                className="size-7"
                onClick={() => navigate(1)}
                disabled={page <= 1 || loading}
              >
                <ChevronsLeft className="size-3" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="size-7"
                onClick={() => navigate(page - 1)}
                disabled={page <= 1 || loading}
              >
                <ChevronLeft className="size-3" />
              </Button>
              <span className="px-2 text-xs text-muted-foreground">
                {page} / {totalPages}
              </span>
              <Button
                variant="outline"
                size="icon"
                className="size-7"
                onClick={() => navigate(page + 1)}
                disabled={page >= totalPages || loading}
              >
                <ChevronRight className="size-3" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="size-7"
                onClick={() => navigate(totalPages)}
                disabled={page >= totalPages || loading}
              >
                <ChevronsRight className="size-3" />
              </Button>
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-end gap-2 pt-2">
          <div className="relative flex-1 min-w-[140px] max-w-[220px]">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <Input
              placeholder="Search cards..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") updateFilter("search", searchInput);
              }}
              className="h-8 pl-7 text-xs"
            />
          </div>
          <Select
            value={rarity}
            onValueChange={(v) => updateFilter("rarity", v)}
          >
            <SelectTrigger className="h-8 w-[120px] text-xs">
              <SelectValue placeholder="Rarity" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All rarities</SelectItem>
              <SelectItem value="common">Common</SelectItem>
              <SelectItem value="uncommon">Uncommon</SelectItem>
              <SelectItem value="rare">Rare</SelectItem>
              <SelectItem value="ultra rare">Ultra Rare</SelectItem>
              <SelectItem value="legendary">Legendary</SelectItem>
              <SelectItem value="secret">Secret</SelectItem>
            </SelectContent>
          </Select>
          <Select value={sort} onValueChange={(v) => updateFilter("sort", v)}>
            <SelectTrigger className="h-8 w-[120px] text-xs">
              <SelectValue placeholder="Sort" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="newest">Newest</SelectItem>
              <SelectItem value="oldest">Oldest</SelectItem>
              <SelectItem value="price_desc">Price High</SelectItem>
              <SelectItem value="price_asc">Price Low</SelectItem>
            </SelectContent>
          </Select>
          <div className="flex items-center gap-1.5">
            <Input
              type="number"
              placeholder="Min $"
              value={priceMin}
              onChange={(e) => updateFilter("priceMin", e.target.value)}
              className="h-8 w-[90px] text-xs"
            />
            <span className="text-xs text-muted-foreground">-</span>
            <Input
              type="number"
              placeholder="Max $"
              value={priceMax}
              onChange={(e) => updateFilter("priceMax", e.target.value)}
              className="h-8 w-[90px] text-xs"
            />
          </div>
          {hasFilters && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-xs px-2"
              onClick={clearFilters}
            >
              <X className="size-3 mr-1" />
              Clear
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="relative">
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/60 rounded-b-lg">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        )}
        {(() => {
          const renderCard = (item: InventoryItem) => (
            <div
              key={item.id}
              className="group relative rounded-lg border bg-card overflow-hidden transition-shadow hover:shadow-md"
            >
              <div className="aspect-[2/3] relative bg-muted">
                <CardImage
                  src={item.imageUrl}
                  alt={item.cardName}
                  className="size-full rounded-t-lg"
                />
                {item.rarity && (
                  <span
                    className={`absolute bottom-1 left-1 rounded px-1 py-0.5 text-[10px] font-semibold leading-none shadow backdrop-blur-sm ${INVENTORY_RARITY_COLORS[item.rarity.toLowerCase()] ?? "bg-black/80 text-white"}`}
                  >
                    {item.rarity}
                  </span>
                )}
              </div>
              <div className="p-1 space-y-0">
                <p
                  className="text-[10px] font-medium truncate"
                  title={item.cardName}
                >
                  {item.cardName}
                </p>
                <p className="text-xs font-medium text-muted-foreground">
                  {formatCurrency(item.value)}
                </p>
              </div>
            </div>
          );

          const gridClass =
            "grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10 gap-1.5";

          return (
            <>
              {data.length > 0 ? (
                <div className={gridClass}>{data.map(renderCard)}</div>
              ) : (
                <p className="text-center text-sm text-muted-foreground py-8">
                  {hasFilters
                    ? "No items match your filters"
                    : "No items in inventory"}
                </p>
              )}
            </>
          );
        })()}
      </CardContent>
    </Card>
  );
});

/* ── Creator Section ── */

const CreatorSection = React.memo(function CreatorSection({
  user,
  creatorData,
  affiliate,
}: {
  user: UserDetail["user"];
  creatorData: CreatorData;
  affiliate: UserDetail["affiliate"];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [codeInput, setCodeInput] = useState("");
  const [newCodeInput, setNewCodeInput] = useState("");

  // affiliate_code on user table may be null even when affiliate_accounts exists
  const effectiveCode = user.affiliateCode ?? affiliate?.code ?? null;

  const handleAssign = () => {
    startTransition(async () => {
      try {
        await assignAffiliateCode(user.id, codeInput.trim());
        toast.success("Affiliate code assigned");
        setCodeInput("");
        router.refresh();
      } catch (e) {
        toast.error(
          e instanceof Error ? e.message : "Failed to assign affiliate code",
        );
      }
    });
  };

  const handleClear = () => {
    startTransition(async () => {
      try {
        await assignAffiliateCode(user.id, null);
        toast.success("Affiliate code cleared");
        setCodeInput("");
        router.refresh();
      } catch (e) {
        toast.error(
          e instanceof Error ? e.message : "Failed to clear affiliate code",
        );
      }
    });
  };

  const handleCreateCode = () => {
    startTransition(async () => {
      try {
        const result = await createAffiliateCode(user.id, newCodeInput.trim());
        if (!result.success) {
          toast.error(result.error ?? "Failed to create affiliate code");
          return;
        }
        toast.success("Affiliate code created");
        setNewCodeInput("");
        router.refresh();
      } catch (e) {
        toast.error(
          e instanceof Error ? e.message : "Failed to create affiliate code",
        );
      }
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">
          Affiliate & Referral
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Zone 1 — Info grid */}
        <div
          className={`grid gap-6 ${effectiveCode && affiliate ? "lg:grid-cols-3 md:grid-cols-2" : effectiveCode || affiliate ? "md:grid-cols-2" : ""}`}
        >
          {/* Column 1: Referral */}
          <div className="space-y-2.5">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              Referral
            </p>
            {user.referredBy ? (
              <InfoRow
                label="Referred By"
                value={
                  <Link
                    href={`/users/${user.referredBy}`}
                    className="text-blue-400 hover:underline"
                  >
                    {user.referredByUsername}
                  </Link>
                }
              />
            ) : (
              <p className="text-sm text-muted-foreground">Not referred</p>
            )}
            <div className="pt-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                Assign Affiliate Code
              </p>
              <div className="flex items-center gap-2">
                <Input
                  placeholder="Enter code"
                  value={codeInput}
                  onChange={(e) => setCodeInput(e.target.value)}
                  className="h-8 w-40 text-sm"
                  disabled={isPending}
                />
                <Button
                  size="sm"
                  disabled={isPending || !codeInput.trim()}
                  onClick={handleAssign}
                >
                  {isPending ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    "Save"
                  )}
                </Button>
                {user.referredBy && (
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={isPending}
                    onClick={handleClear}
                  >
                    Clear
                  </Button>
                )}
              </div>
            </div>
          </div>

          {/* Column 2: Affiliate Code */}
          {effectiveCode ? (
            <div className="space-y-2.5">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                Affiliate Code
              </p>
              <InfoRow label="Code" value={effectiveCode} mono />
              <InfoRow
                label="Status"
                value={
                  <Badge
                    variant="outline"
                    className={
                      user.affiliateCodeActive
                        ? "bg-green-500/15 text-green-600 dark:text-green-400"
                        : "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400"
                    }
                  >
                    {user.affiliateCodeActive ? "Active" : "Inactive"}
                  </Badge>
                }
              />
              {user.affiliateCodeExpiresAt && (
                <InfoRow
                  label="Expires"
                  value={formatDateTime(user.affiliateCodeExpiresAt)}
                />
              )}
              <InfoRow
                label="Bonus Opted In"
                value={user.affiliateBonusOptedIn ? "Yes" : "No"}
              />
            </div>
          ) : (
            <div className="space-y-2.5">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                Create Affiliate Code
              </p>
              <p className="text-sm text-muted-foreground">
                No affiliate code yet
              </p>
              <div className="flex items-center gap-2">
                <Input
                  placeholder="Enter code"
                  value={newCodeInput}
                  onChange={(e) => setNewCodeInput(e.target.value)}
                  className="h-8 w-40 text-sm"
                  disabled={isPending}
                />
                <Button
                  size="sm"
                  disabled={isPending || !newCodeInput.trim()}
                  onClick={handleCreateCode}
                >
                  {isPending ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    "Create"
                  )}
                </Button>
              </div>
            </div>
          )}

          {/* Column 3: Affiliate Stats (only if affiliate data exists) */}
          {affiliate && (
            <div className="space-y-2.5">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                Affiliate Stats
              </p>
              <InfoRow
                label="Total Referred"
                value={String(affiliate.totalReferred)}
              />
              <InfoRow
                label="Wager Volume"
                value={formatCurrency(affiliate.totalWagerVolumeUsd)}
              />
              <InfoRow
                label="Total Earned"
                value={formatCurrency(affiliate.totalEarnedUsd)}
              />
              <InfoRow
                label="Available"
                value={formatCurrency(affiliate.availableUsd)}
              />
              <InfoRow
                label="Paid Out"
                value={formatCurrency(affiliate.totalPaidOutUsd)}
              />
              <InfoRow
                label="Bonus Distributed"
                value={formatCurrency(affiliate.totalBonusDistributedUsd)}
              />
              {affiliate.lastPayoutAt && (
                <InfoRow
                  label="Last Payout"
                  value={formatDateTime(affiliate.lastPayoutAt)}
                />
              )}
            </div>
          )}
        </div>

        {/* Zone 2 — Tables (only when user has an affiliate code) */}
        {effectiveCode && (
          <>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                Referral Clicks ({creatorData.clicks.total})
              </p>
              <ReferralClicksTable
                affiliateCode={effectiveCode}
                initialData={creatorData.clicks}
              />
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                Code Usages ({creatorData.usages.total})
              </p>
              <CodeUsagesTable
                userId={user.id}
                initialData={creatorData.usages}
              />
            </div>
          </>
        )}

        {/* Zone 3 — Withdrawal Limits (only for creators) */}
        {user.role === "creator" && (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
              Withdrawal Limits
            </p>
            <WithdrawalLimitsCard
              userId={user.id}
              limits={creatorData.withdrawalLimits}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
});

function ReferralClicksTable({
  affiliateCode,
  initialData,
}: {
  affiliateCode: string | null;
  initialData: CreatorData["clicks"];
}) {
  const [data, setData] = useState(initialData);
  const [page, setPage] = useState(initialData.page);
  const [isPending, startTransition] = useTransition();

  if (!affiliateCode) {
    return (
      <p className="text-sm text-muted-foreground">
        No affiliate code configured
      </p>
    );
  }

  function goToPage(p: number) {
    setPage(p);
    startTransition(async () => {
      const result = await fetchCreatorClicks(affiliateCode!, p, 20);
      setData(result);
    });
  }

  return (
    <div className="space-y-2">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>IP</TableHead>
            <TableHead>Country</TableHead>
            <TableHead>Region</TableHead>
            <TableHead>City</TableHead>
            <TableHead>User Agent</TableHead>
            <TableHead>Date</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.data.map((click) => (
            <TableRow key={click.id}>
              <TableCell className="font-mono text-xs">{click.ip}</TableCell>
              <TableCell>{click.country}</TableCell>
              <TableCell>{click.region}</TableCell>
              <TableCell>{click.city}</TableCell>
              <TableCell
                className="max-w-[200px] truncate text-xs"
                title={click.userAgent ?? ""}
              >
                {click.userAgent ?? "-"}
              </TableCell>
              <TableCell>
                {click.createdAt ? formatDateTime(click.createdAt) : "-"}
              </TableCell>
            </TableRow>
          ))}
          {data.data.length === 0 && (
            <TableRow>
              <TableCell
                colSpan={6}
                className="h-24 text-center text-muted-foreground"
              >
                No clicks yet.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      {data.totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{data.total} total clicks</span>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={page <= 1 || isPending}
              onClick={() => goToPage(1)}
            >
              <ChevronsLeft className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={page <= 1 || isPending}
              onClick={() => goToPage(page - 1)}
            >
              <ChevronLeft className="size-3.5" />
            </Button>
            <span className="px-2">
              Page {page} of {data.totalPages}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={page >= data.totalPages || isPending}
              onClick={() => goToPage(page + 1)}
            >
              <ChevronRight className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={page >= data.totalPages || isPending}
              onClick={() => goToPage(data.totalPages)}
            >
              <ChevronsRight className="size-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function CodeUsagesTable({
  userId,
  initialData,
}: {
  userId: string;
  initialData: CreatorData["usages"];
}) {
  const [data, setData] = useState(initialData);
  const [page, setPage] = useState(initialData.page);
  const [isPending, startTransition] = useTransition();

  function goToPage(p: number) {
    setPage(p);
    startTransition(async () => {
      const result = await fetchCreatorCodeUsages(userId, p, 20);
      setData(result);
    });
  }

  return (
    <div className="space-y-2">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>User</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Deposit</TableHead>
            <TableHead>Wager</TableHead>
            <TableHead>Referrer Cut</TableHead>
            <TableHead>User Bonus</TableHead>
            <TableHead>Date</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.data.map((u) => (
            <TableRow key={u.id}>
              <TableCell>
                <Link
                  href={`/users/${u.referredUserId}`}
                  className="hover:underline"
                >
                  {u.referredUsername ?? u.referredUserId.slice(0, 8)}
                </Link>
              </TableCell>
              <TableCell>
                <Badge variant="outline">{u.usageType}</Badge>
              </TableCell>
              <TableCell>{formatCurrency(u.depositAmountUsd)}</TableCell>
              <TableCell>{formatCurrency(u.wagerAmountUsd)}</TableCell>
              <TableCell className="text-green-400">
                {formatCurrency(u.referrerCutUsd)}
              </TableCell>
              <TableCell>{formatCurrency(u.userBonusUsd)}</TableCell>
              <TableCell>{formatDateTime(u.createdAt)}</TableCell>
            </TableRow>
          ))}
          {data.data.length === 0 && (
            <TableRow>
              <TableCell
                colSpan={7}
                className="h-24 text-center text-muted-foreground"
              >
                No code usages yet.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      {data.totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{data.total} total usages</span>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={page <= 1 || isPending}
              onClick={() => goToPage(1)}
            >
              <ChevronsLeft className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={page <= 1 || isPending}
              onClick={() => goToPage(page - 1)}
            >
              <ChevronLeft className="size-3.5" />
            </Button>
            <span className="px-2">
              Page {page} of {data.totalPages}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={page >= data.totalPages || isPending}
              onClick={() => goToPage(page + 1)}
            >
              <ChevronRight className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={page >= data.totalPages || isPending}
              onClick={() => goToPage(data.totalPages)}
            >
              <ChevronsRight className="size-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function WithdrawalLimitsCard({
  userId,
  limits,
}: {
  userId: string;
  limits: WithdrawalLimits;
}) {
  const [editOpen, setEditOpen] = useState(false);

  return (
    <div className="space-y-3">
      {limits ? (
        <>
          <InfoRow
            label="Currency Limit Amount"
            value={
              limits.currencyLimitAmount != null
                ? formatCurrency(limits.currencyLimitAmount)
                : "-"
            }
          />
          <InfoRow
            label="Limit Start Date"
            value={
              limits.currencyLimitStartDate
                ? formatDateTime(limits.currencyLimitStartDate)
                : "-"
            }
          />
          <InfoRow
            label="Reset Days"
            value={
              limits.currencyLimitResetDays != null
                ? String(limits.currencyLimitResetDays)
                : "-"
            }
          />
          <InfoRow
            label="Percentage Limit"
            value={
              limits.percentageLimit != null
                ? `${(limits.percentageLimit * 100).toFixed(2)}%`
                : "-"
            }
          />
        </>
      ) : (
        <p className="text-sm text-muted-foreground">No limits configured</p>
      )}
      <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
        {limits ? "Edit Limits" : "Set Limits"}
      </Button>
      <WithdrawalLimitsDialog
        userId={userId}
        limits={limits}
        open={editOpen}
        onOpenChange={setEditOpen}
      />
    </div>
  );
}

function WithdrawalLimitsDialog({
  userId,
  limits,
  open,
  onOpenChange,
}: {
  userId: string;
  limits: WithdrawalLimits;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [amount, setAmount] = useState(
    limits?.currencyLimitAmount != null
      ? String(limits.currencyLimitAmount)
      : "",
  );
  const [startDate, setStartDate] = useState(
    limits?.currencyLimitStartDate
      ? limits.currencyLimitStartDate.slice(0, 16)
      : "",
  );
  const [resetDays, setResetDays] = useState(
    limits?.currencyLimitResetDays != null
      ? String(limits.currencyLimitResetDays)
      : "",
  );
  const [percentage, setPercentage] = useState(
    limits?.percentageLimit != null ? String(limits.percentageLimit * 100) : "",
  );
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  useEffect(() => {
    if (open) {
      setAmount(
        limits?.currencyLimitAmount != null
          ? String(limits.currencyLimitAmount)
          : "",
      );
      setStartDate(
        limits?.currencyLimitStartDate
          ? limits.currencyLimitStartDate.slice(0, 16)
          : "",
      );
      setResetDays(
        limits?.currencyLimitResetDays != null
          ? String(limits.currencyLimitResetDays)
          : "",
      );
      setPercentage(
        limits?.percentageLimit != null
          ? String(limits.percentageLimit * 100)
          : "",
      );
    }
  }, [open, limits]);

  function handleSave() {
    startTransition(async () => {
      try {
        await updateWithdrawalLimits({
          userId,
          currencyLimitAmount: amount ? parseFloat(amount) : null,
          currencyLimitStartDate: startDate || null,
          currencyLimitResetDays: resetDays ? parseInt(resetDays, 10) : null,
          percentageLimit: percentage ? parseFloat(percentage) / 100 : null,
        });
        toast.success("Withdrawal limits updated");
        onOpenChange(false);
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to update limits");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Withdrawal Limits</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              Currency Limit Amount
            </Label>
            <Input
              type="number"
              placeholder="e.g. 1000"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Start Date</Label>
            <Input
              type="datetime-local"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Reset Days</Label>
            <Input
              type="number"
              placeholder="e.g. 30"
              value={resetDays}
              onChange={(e) => setResetDays(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              Percentage Limit (%)
            </Label>
            <Input
              type="number"
              step="0.01"
              placeholder="e.g. 5.00"
              value={percentage}
              onChange={(e) => setPercentage(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={isPending}
            className="w-full"
          >
            {isPending ? "Saving..." : "Save Limits"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InfoRow({
  label,
  value,
  mono,
  truncate: shouldTruncate,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  truncate?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 min-w-0">
      <span className="text-sm text-muted-foreground shrink-0">{label}</span>
      <span
        className={`text-sm min-w-0 tabular-nums ${mono ? "font-mono text-xs" : ""} ${shouldTruncate ? "truncate" : ""}`}
        title={shouldTruncate && typeof value === "string" ? value : undefined}
      >
        {value}
      </span>
    </div>
  );
}

/* ── Notes Section ── */
const NotesSection = React.memo(function NotesSection({
  userId,
  notes,
}: {
  userId: string;
  notes: AdminNote[];
}) {
  const [content, setContent] = useState("");
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!content.trim()) return;
    startTransition(async () => {
      try {
        await createNote(userId, content);
        setContent("");
        toast.success("Note added");
        router.refresh();
      } catch {
        toast.error("Failed to add note");
      }
    });
  }

  function handleDelete(noteId: string) {
    startTransition(async () => {
      try {
        await deleteNote(noteId);
        toast.success("Note deleted");
        router.refresh();
      } catch {
        toast.error("Failed to delete note");
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">
          Notes ({notes.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={handleSubmit} className="space-y-2">
          <Textarea
            placeholder="Add a note about this user..."
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={3}
          />
          <Button
            type="submit"
            size="sm"
            disabled={isPending || !content.trim()}
          >
            {isPending && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
            Add Note
          </Button>
        </form>

        {notes.length > 0 && (
          <div className="space-y-3 border-t pt-4">
            {notes.map((note) => (
              <div key={note.id} className="rounded-md border p-3 space-y-1">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">
                      {note.adminUsername}
                    </span>
                    <span>{formatRelative(note.createdAt)}</span>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6"
                    onClick={() => handleDelete(note.id)}
                    disabled={isPending}
                  >
                    <Trash2 className="size-3" />
                  </Button>
                </div>
                <p className="text-sm whitespace-pre-wrap">{note.content}</p>
              </div>
            ))}
          </div>
        )}

        {notes.length === 0 && (
          <p className="text-sm text-muted-foreground">No notes yet</p>
        )}
      </CardContent>
    </Card>
  );
});

// ---------------------------------------------------------------------------
// Wipe Account Button + Confirmation Dialog (Admin Only)
// ---------------------------------------------------------------------------
function WipeAccountButton({
  userId,
  displayName,
}: {
  userId: string;
  displayName: string;
}) {
  const [open, setOpen] = useState(false);
  const [confirmValue, setConfirmValue] = useState("");
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const isConfirmed = confirmValue === displayName;

  function handleWipe() {
    if (!isConfirmed) return;
    startTransition(async () => {
      try {
        const result = await wipeUserAccount(userId, confirmValue);
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        toast.success("Account data wiped successfully");
        setOpen(false);
        setConfirmValue("");
        router.refresh();
      } catch (e) {
        toast.error(
          e instanceof Error ? e.message : "Failed to wipe account data",
        );
      }
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) setConfirmValue(""); }}>
      <AlertDialogTrigger
        render={
          <Button variant="destructive" size="sm" className="mt-4" />
        }
      >
        <Trash2 className="mr-2 size-4" />
        Wipe Account Data
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Wipe All Account Data?</AlertDialogTitle>
          <AlertDialogDescription className="space-y-2">
            <span className="block">
              This will <strong>permanently delete</strong> all data for this
              account: balances, transactions, inventory, battles, rewards,
              affiliate data, chat messages, and all ledger history.
            </span>
            <span className="block">
              The user record and login credentials will be preserved, but
              everything else will be gone. <strong>This cannot be undone.</strong>
            </span>
            <span className="mt-3 block text-sm">
              Type <strong className="font-mono text-foreground">{displayName}</strong> to confirm:
            </span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Input
          value={confirmValue}
          onChange={(e) => setConfirmValue(e.target.value)}
          placeholder={displayName}
          className="font-mono"
          autoComplete="off"
        />
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button
            variant="destructive"
            onClick={handleWipe}
            disabled={!isConfirmed || isPending}
          >
            {isPending ? "Wiping..." : "Wipe Account Data"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
