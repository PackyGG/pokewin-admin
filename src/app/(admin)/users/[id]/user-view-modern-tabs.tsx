"use client";

/**
 * Tab panel components for the modern user detail view. Each tab receives
 * the already-fetched data from the parent UserViewModern component and
 * renders the relevant sections. Pure presentation — data lives in the
 * parent, mutations flow through the shared section components.
 */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useMemo, useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { assignAffiliateCode } from "./actions";
import { SetAffiliateCodeDialog } from "./user-tabs-creator";
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
  ArrowUpRight,
  Sparkles,
  Dices,
  Percent,
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
import type { PaginatedInventory } from "./user-tabs-types";
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
    <div className="space-y-4 sm:space-y-6">
      {/* Modern stat panels — purpose-built to match the hero aesthetic:
          rounded-2xl, subtle colored corner glow, color-accented icon
          chip + hero number + breakdown rows below. */}
      <div className="grid gap-3 sm:gap-4 grid-cols-1 md:grid-cols-3">
        <ModernBalancePanel
          balances={balances}
          userId={user.id}
          canAdjustBalance={capabilities.canAdjustBalance}
          canRecordManualWithdrawal={capabilities.canRecordManualWithdrawal}
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

export function InventoryTab({
  data,
  inventory,
  disposedInventory,
}: {
  data: UserDetail;
  inventory: PaginatedInventory;
  disposedInventory: PaginatedInventory;
}) {
  const { user, balances } = data;
  return (
    <div className="space-y-6">
      <SectionHeading icon={Gem} title="Current Inventory" />
      <InventoryGrid
        userId={user.id}
        initialInventory={inventory}
        inventoryValue={balances?.inventoryValue ?? 0}
        statusFilter="owned"
      />
      <SectionHeading icon={Trophy} title="Sold & Exchanged" />
      <DisposedCardsTable
        userId={user.id}
        initialInventory={disposedInventory}
      />
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────
//  CREATOR TAB
// ───────────────────────────────────────────────────────────────────

export function AffiliateTab({ data }: { data: UserDetail }) {
  const { user, affiliate } = data;
  return (
    <div className="space-y-6">
      {/* Creator deep-link — only for users actually flagged creator.
          The /creators/[userId] page has the full panel: deals,
          webhooks, payouts, code analytics, clicks, signup tracking.
          Inline-duplicating that here would be a maintenance nightmare. */}
      {user.role === "creator" && (
        <Card className="overflow-hidden">
          <CardContent className="flex flex-col gap-3 sm:gap-4 p-4 sm:p-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3 min-w-0">
              <div className="flex size-10 items-center justify-center rounded-lg bg-purple-500/15 shrink-0">
                <Sparkles className="size-5 text-purple-500" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold">Creator Dashboard</p>
                <p className="text-xs text-muted-foreground truncate">
                  Deals, webhooks, payouts, click + signup analytics
                </p>
              </div>
            </div>
            <a
              href={`/creators/${user.id}`}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 min-h-[44px] shrink-0"
            >
              Open Creator Dashboard
              <span aria-hidden>→</span>
            </a>
          </CardContent>
        </Card>
      )}

      {/* Two visually distinct sections — each manages a DIFFERENT
          column on the user table:
            • ReferrerCard ↓ writes user.referred_by  (who referred them in)
            • OwnCodeCard  → writes user.affiliate_code (what code they own)
          The labels and panel styling are deliberately different so
          admins can't confuse the two — the previous "Referral Code
          Used" / "Own Affiliate Code" naming was too symmetric. */}
      <SectionHeading
        icon={ArrowDownToLine}
        title="Joined Under (Referrer)"
      />
      <ReferrerCard user={user} />

      <SectionHeading icon={Sparkles} title="Their Own Affiliate Code" />
      <OwnCodeCard user={user} affiliate={affiliate} />

      {/* Section 3: Stats — only render if the affiliate_accounts row exists */}
      {affiliate && (
        <>
          <SectionHeading icon={TrendingUp} title="Affiliate Stats" />
          <div className="grid gap-3 sm:gap-4 grid-cols-2 lg:grid-cols-3">
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
            {/* The four tiles below describe money the HOUSE has paid
                (or will pay) → house-loss side of the ledger → rose
                per CLAUDE.md. */}
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
        </>
      )}
    </div>
  );
}

// ── Referrer card — sets user.referred_by via a code lookup ────────
//
// Admins enter a code (someone else's affiliate code), the action
// looks up the owner and writes user.referred_by = owner.id, plus
// bumps that owner's affiliate_accounts.total_referred. Exists for
// the case where a referral signup got dropped and needs to be
// reattributed manually.
function ReferrerCard({ user }: { user: UserDetail["user"] }) {
  const router = useRouter();
  const [codeInput, setCodeInput] = useState("");
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleAssign() {
    const trimmed = codeInput.trim();
    if (!trimmed) {
      toast.error("Enter a code");
      return;
    }
    startTransition(async () => {
      try {
        await assignAffiliateCode(user.id, trimmed);
        toast.success(`Referrer set via code "${trimmed}"`);
        setCodeInput("");
        router.refresh();
      } catch (e) {
        toast.error(
          e instanceof Error ? e.message : "Failed to set referrer",
        );
      }
    });
  }

  function handleClear() {
    startTransition(async () => {
      try {
        await assignAffiliateCode(user.id, null);
        toast.success("Referrer cleared");
        setConfirmClearOpen(false);
        router.refresh();
      } catch (e) {
        toast.error(
          e instanceof Error ? e.message : "Failed to clear referrer",
        );
      }
    });
  }

  // Three states this section can be in:
  //   1. referred_by set                — formal attribution; show
  //                                       owner + code, offer Clear.
  //   2. referred_by null, cookie set   — backend wrote the cookie
  //                                       (affiliate_code) when the
  //                                       user clicked a link, but
  //                                       no formal referral was
  //                                       attributed yet (typically
  //                                       happens on first deposit).
  //                                       Show the cookie so admins
  //                                       can SEE which code the
  //                                       user is carrying — that
  //                                       answers "why does it say
  //                                       no referrer when he used
  //                                       twitter".
  //   3. neither set                    — genuinely organic signup.
  const carriedCookie = user.affiliateCode;
  const hasFormalReferrer = Boolean(user.referredBy);
  const hasCarriedCookie = Boolean(carriedCookie);

  return (
    // Subtle blue accent on this card so it visually distinguishes
    // from the Sparkles/purple "Own Affiliate Code" card below.
    // Same Card primitive — different left-border tint.
    <Card className="border-l-4 border-l-blue-500/40">
      <CardContent className="space-y-4 pt-6">
        <div className="space-y-2">
          {hasFormalReferrer ? (
            <div className="space-y-2">
              <p className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground">
                Joined under code
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {/* The actual code string is the headline — it's what
                    admins are usually asked about. Mono font, tinted
                    background so it reads as a token, not body text. */}
                {user.referredByCode ? (
                  <span className="rounded-md bg-blue-500/15 px-2 py-1 font-mono text-sm font-semibold text-blue-700 dark:text-blue-300">
                    {user.referredByCode}
                  </span>
                ) : (
                  <span className="text-sm italic text-muted-foreground">
                    code unknown
                  </span>
                )}
                <span className="text-xs text-muted-foreground">
                  owned by
                </span>
                <Link
                  href={`/users/${user.referredBy}`}
                  className="text-sm font-medium text-blue-500 hover:underline"
                >
                  @{user.referredByUsername ?? user.referredBy?.slice(0, 8)}
                </Link>
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto h-7 gap-1.5 text-xs text-rose-500 border-rose-500/40 hover:bg-rose-500/10"
                  onClick={() => setConfirmClearOpen(true)}
                  disabled={isPending}
                >
                  Clear
                </Button>
              </div>
            </div>
          ) : hasCarriedCookie ? (
            <div className="space-y-2">
              <p className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground">
                Carrying referral cookie
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-md bg-blue-500/15 px-2 py-1 font-mono text-sm font-semibold text-blue-700 dark:text-blue-300">
                  {carriedCookie}
                </span>
                <Badge
                  variant="outline"
                  className="bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30"
                >
                  Not yet attributed
                </Badge>
              </div>
              <p className="text-[11px] text-muted-foreground">
                This user clicked a referral link but isn&apos;t yet
                formally attributed to the code&apos;s owner — that
                normally happens on their first deposit. Use the
                input below to attribute manually if you need to.
              </p>
            </div>
          ) : (
            <>
              <p className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground">
                Joined under code
              </p>
              <p className="text-sm text-muted-foreground">
                This user wasn&apos;t referred by anyone.
              </p>
            </>
          )}
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">
            {user.referredBy
              ? "Change which code they joined under"
              : "Set the code they joined under"}
          </Label>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              placeholder="Enter someone else's code (e.g. POKEMASTER)"
              value={codeInput}
              onChange={(e) => setCodeInput(e.target.value)}
              className="h-9 w-full sm:w-64 font-mono text-sm"
              disabled={isPending}
              onKeyDown={(e) => {
                if (e.key === "Enter" && codeInput.trim() && !isPending) {
                  handleAssign();
                }
              }}
            />
            <Button
              size="sm"
              disabled={isPending || !codeInput.trim()}
              onClick={handleAssign}
            >
              {isPending ? "Saving…" : user.referredBy ? "Change referrer" : "Set referrer"}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            ⚠ This sets <span className="font-mono">user.referred_by</span>{" "}
            — i.e. WHO referred THIS user in. The code must already be
            owned by another user. To give THIS user their own code to
            hand out instead, use the section below.
          </p>
        </div>
      </CardContent>

      <AlertDialog open={confirmClearOpen} onOpenChange={setConfirmClearOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear referrer?</AlertDialogTitle>
            <AlertDialogDescription>
              Removes this user&apos;s{" "}
              <span className="font-mono">referred_by</span> link and
              decrements the previous referrer&apos;s{" "}
              <span className="font-mono">total_referred</span>{" "}
              counter. Historical{" "}
              <span className="font-mono">affiliate_code_usages</span>{" "}
              rows are not touched (those are a permanent audit trail).
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleClear}
              disabled={isPending}
              className="bg-rose-500 hover:bg-rose-500/90"
            >
              {isPending ? "Clearing…" : "Clear referrer"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

// ── Own affiliate code card — manages user.affiliate_code ──────────
//
// Wraps the existing SetAffiliateCodeDialog from user-tabs-creator
// which handles both the create and the take-over-collision-with-
// transfer paths. The card itself just shows the current code state
// and the trigger button.
function OwnCodeCard({
  user,
  affiliate,
}: {
  user: UserDetail["user"];
  affiliate: UserDetail["affiliate"];
}) {
  const [setCodeOpen, setSetCodeOpen] = useState(false);
  void affiliate; // intentionally unused — owned codes come from user.ownedCodes
  // SCHEMA NOTE: ownership lives EXCLUSIVELY in the affiliate_codes
  // table (= user.ownedCodes here). user.affiliate_code is the
  // backend's referral-cookie field — the code this user is CARRYING
  // because someone referred them — and is surfaced in ReferrerCard
  // above, not here. Mixing the two was the source of the
  // "owns code twitter / actually owns wynn" report.
  const owned = user.ownedCodes;
  const hasAny = owned.length > 0;

  return (
    // Purple left-border so it's visually distinct from the blue
    // ReferrerCard above. Two completely different DB sources.
    <Card className="border-l-4 border-l-purple-500/40">
      <CardContent className="space-y-4 pt-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground">
            Codes they own ({owned.length})
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setSetCodeOpen(true)}
          >
            {hasAny ? "Add another code" : "Set affiliate code"}
          </Button>
        </div>

        {hasAny ? (
          <div className="space-y-1.5">
            {owned.map((c) => (
              <OwnedCodeRow
                key={c.code}
                code={c.code}
                createdAt={c.createdAt}
                userRole={user.role}
                userId={user.id}
              />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            This user doesn&apos;t own any codes yet.
          </p>
        )}

        <p className="text-[11px] text-muted-foreground">
          Source of truth:{" "}
          <span className="font-mono">affiliate_codes</span> table. Each
          row above is a code this user owns and can hand out to refer
          others. Codes are added via &quot;Add another code&quot; or
          on /creators/[id]. To remove or transfer a code, use the
          /creators dashboard.
        </p>
      </CardContent>
      <SetAffiliateCodeDialog
        open={setCodeOpen}
        onOpenChange={setSetCodeOpen}
        userId={user.id}
        currentUsername={user.username ?? user.email ?? null}
      />
    </Card>
  );
}

// One row in the owned-codes list. Each row is a tappable link to
// the code's stat page (or, for users with role=creator, the
// creator dashboard which has the full deep-dive).
function OwnedCodeRow({
  code,
  createdAt,
  userRole,
  userId,
}: {
  code: string;
  createdAt: string;
  userRole: string;
  userId: string;
}) {
  const codeHref =
    userRole === "creator"
      ? `/creators/${userId}`
      : `/creators/codes/${encodeURIComponent(code)}`;
  return (
    <Link
      href={codeHref}
      className="group flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 transition-colors hover:border-purple-500/30 hover:bg-purple-500/5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 rounded-md bg-purple-500/15 px-2 py-1 font-mono text-sm font-semibold text-purple-700 dark:text-purple-300">
          {code}
          <ArrowUpRight className="size-3 opacity-50 transition-opacity group-hover:opacity-100" />
        </span>
      </div>
      <span className="text-[11px] text-muted-foreground">
        added {formatRelative(createdAt)}
      </span>
    </Link>
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
  const { user, balances, shippingAddress, vault, depositAddresses, featureLocks, mutes, capabilities } = data;
  void isAdmin; // currently only consumed by downstream components
  return (
    <div className="space-y-6">
      <SectionHeading icon={Dices} title="Wagering Stats" />
      <WageringStatsCard balances={balances} />
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

// Wagering stats — moved out of the hero KPI strip to keep the hero
// compact. Headline number is Wager Loss (totalWagered − totalWon)
// from the HOUSE perspective: positive means we won that money, so
// emerald; negative means the user is up on bets, so rose. The three
// supporting tiles (wagered, won, house edge) give context.
function WageringStatsCard({
  balances,
}: {
  balances: UserDetail["balances"];
}) {
  if (!balances) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          No wagering data yet.
        </CardContent>
      </Card>
    );
  }
  const wagerLoss = balances.totalWagered - balances.totalWon;
  const houseEdge =
    balances.totalWagered > 0
      ? ((balances.totalWagered - balances.totalWon) / balances.totalWagered) *
        100
      : 0;
  const isHouseUp = wagerLoss >= 0;
  return (
    <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
      <ModernMetricTile
        label="Wager Loss"
        value={
          balances.totalWagered > 0
            ? `${isHouseUp ? "+" : ""}${formatCurrency(wagerLoss)}`
            : "—"
        }
        accent={isHouseUp ? "emerald" : "rose"}
        icon={isHouseUp ? TrendingUp : TrendingDown}
      />
      <ModernMetricTile
        label="Total Wagered"
        value={formatCurrency(balances.totalWagered)}
        accent="amber"
        icon={Coins}
      />
      <ModernMetricTile
        label="Total Won"
        value={formatCurrency(balances.totalWon)}
        accent="rose"
        icon={Trophy}
      />
      <ModernMetricTile
        label="House Edge"
        value={
          balances.totalWagered > 0 ? `${houseEdge.toFixed(2)}%` : "—"
        }
        accent="purple"
        icon={Percent}
      />
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

