"use client";

import React, { useEffect, useState, useTransition, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
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
  X,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
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
  DialogFooter,
} from "@/components/ui/dialog";
import {
  ROLE_COLORS,
  USER_STATUS_COLORS,
  STATUS_COLORS,
} from "@/lib/constants";
import {
  formatCurrency,
  formatRelative,
} from "@/lib/utils/format";
import {
  banUser,
  unbanUser,
  lockUser,
  unlockUser,
} from "../actions";
import type { UserRewards } from "@/lib/queries/users";
import {
  changeRole,
  fetchUserTransactions,
  fetchCreatorClicks,
  fetchCreatorCodeUsages,
  fetchBalanceHistory,
  fetchCreatorWithdrawalLimits,
} from "./actions";
import { UserViewModern } from "./user-view-modern";
import type {
  UserDetail,
  PaginatedTransactions,
  PaginatedAuditLog,
  PaginatedInventory,
  PnlBreakdown,
  AdminNote,
  BalanceHistoryPoint,
  Transaction,
  CreatorData,
} from "./user-tabs-types";
import {
  CARD_SALE_TX_TYPES,
  EXCHANGE_TX_TYPES,
} from "./user-tabs-types";
import {
  DeleteUserDialog,
  WipeAccountButton,
  EditIdentityButton,
} from "./user-tabs-dialogs";

// ---------------------------------------------------------------------------
// Re-exports — preserve the public surface so existing imports keep working.
// ---------------------------------------------------------------------------
export type {
  UserDetail,
  PaginatedTransactions,
  PnlBreakdown,
  AdminNote,
} from "./user-tabs-types";
export {
  GAMING_TX_TYPES,
  FINANCIAL_TX_TYPES,
  CARD_SALE_TX_TYPES,
  EXCHANGE_TX_TYPES,
} from "./user-tabs-types";
export {
  BalanceSummaryCard,
  PnlCard,
  ActivityStatsCard,
  RewardsCard,
  FeatureLocksCard,
  AccountDetailsSection,
  BalanceHistoryChart,
  NotesSection,
} from "./user-tabs-cards";
export { CategoryTransactionsTable } from "./user-tabs-transactions";
export { InventoryGrid, DisposedCardsTable } from "./user-tabs-inventory";
export { CreatorSection } from "./user-tabs-creator";
export { ModerationSection } from "./user-tabs-moderation";

export function UserTabs({
  data,
  transactions,
  auditLog,
  inventory,
  disposedInventory,
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
  disposedInventory: PaginatedInventory;
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
    capabilities,
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
    disposedCards: false,
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

  // Classic view was removed — UserTabs now always renders the modern
  // user detail page. Everything below (openSections, lazyData, etc.)
  // is unreachable and will be cleaned up in a follow-up refactor.
  return (
    <UserViewModern
      data={data}
      gamingTx={gamingTx}
      financialTx={financialTx}
      rewards={rewards}
      notes={notes}
      pnlBreakdown={pnlBreakdown}
    />
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
  capabilities,
}: {
  user: UserDetail["user"];
  isAdmin: boolean;
  counts: UserDetail["counts"];
  capabilities: UserDetail["capabilities"];
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
          <div className="flex items-center gap-1.5">
            <p className="text-lg font-semibold truncate leading-tight">
              {user.displayUsername ?? user.username ?? user.name ?? "—"}
            </p>
            {user.username && user.displayUsername && user.displayUsername !== user.username && (
              <span className="text-xs text-muted-foreground">@{user.username}</span>
            )}
            {capabilities.canEditIdentity && (
              <EditIdentityButton user={user} />
            )}
          </div>
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
          {capabilities.canChangeUserRoles ? (
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

          {capabilities.canBanUsers && (
            !user.isBanned ? (
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
            )
          )}
          {capabilities.canLockUsers && (
            !user.isLocked ? (
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
            )
          )}

          {capabilities.canWipeAccounts && (
            <WipeAccountButton
              userId={user.id}
              displayName={user.username ?? user.email ?? user.id}
            />
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

// Legacy (unreachable) helpers preserved from prior implementation — kept for
// parity until the classic view cleanup lands.
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
