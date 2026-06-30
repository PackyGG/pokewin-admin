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
import { useState, useTransition, use, Suspense } from "react";
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
import { assignAffiliateCode, fetchUserAttributionJourney } from "./actions";
import type { AttributionJourneyEntry } from "@/lib/queries/users";
import { SetAffiliateCodeDialog } from "./user-tabs-creator";
import {
  Wallet,
  TrendingUp,
  TrendingDown,
  Swords,
  Gem,
  Trophy,
  Gift,
  Coins,
  ShieldCheck,
  FileText,
  ArrowDownToLine,
  Banknote,
  ArrowUpFromLine,
  ArrowUpRight,
  Sparkles,
  Dices,
  Percent,
  Award,
  Flag,
  Waypoints,
  Loader2,
  Coins as CoinsIcon,
  GitBranch,
  Lock,
  Landmark,
  ArrowRight,
  Scale,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/empty-state";
import { InlineError } from "@/components/entity-surface/inline-error";
import { SkeletonCard, SkeletonTable } from "@/components/ux";
import { cn } from "@/lib/utils";
import { formatCurrency, formatDateTime, formatNumber } from "@/lib/utils/format";
import { RelativeTime } from "@/components/relative-time";
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
  ADJUSTMENT_TX_TYPES,
} from "./user-tabs";
import { UserBattleLimitsCard } from "./user-battle-limits-card";
import { UserVouchersPanel } from "./user-vouchers-panel";
import { JoinedBattlesPanel } from "./joined-battles-panel";
import { UserWagerRequirementCard } from "./user-wager-requirement-card";
import type { UserWagerRequirement } from "@/lib/backend-api/wager-requirements";
import { UserWagerProgressCard } from "./user-wager-progress-card";
import type { UserWagerProgress } from "@/lib/queries/users-wager-progress";
import { UserBalanceWeightingCard } from "./user-balance-weighting-card";
import type { UserBalanceWeighting } from "@/lib/queries/users-balance-weighting";
import { toWagerRequirementSummary } from "@/lib/queries/users-wager-progress-shared";
import type {
  PaginatedInventory,
  TipEntry,
  LeaderboardWinEntry,
  RaceClaimEntry,
} from "./user-tabs-types";
import {
  CARD_SALE_TX_TYPES,
  BATTLE_VOUCHER_TX_TYPES,
  DEPOSIT_TX_TYPES,
  WITHDRAWAL_TX_TYPES,
} from "./user-tabs-types";
import { isMothaOnlyAdjustmentsProfile } from "@/lib/users/motha-only-adjustments-profile";
import type { UserRewards } from "@/lib/queries/users";
import type { SafeQueryResult } from "@/lib/errors/safe-query";
import type {
  ShardWinningsResult,
  ShardPackOpensResult,
} from "@/lib/queries/users-shard-winnings";
import type { UserXpPurchasesResult } from "@/lib/queries/users-xp-purchases";
import type { UserRewardPackOpensResult } from "@/lib/queries/users-reward-pack-opens";
import type { UserDoubleDownHistory } from "@/lib/queries/double-down";
import {
  ShardWinningsSection,
  ShardPackOpensSection,
} from "./shard-winnings-section";
import { DoubleDownSection } from "./double-down-section";
import { XpPurchasesSection } from "./xp-purchases-section";
import { RewardPackOpensSection } from "./reward-pack-opens-section";
import { BandError } from "./band-error";
import {
  SectionHeading,
  ModernBalancePanel,
  ModernPnlPanel,
  ModernActivityPanel,
  ModernMetricTile,
} from "./user-view-modern-panels";
import { KpiTile, StatPanel } from "@/components/modern-panels";

// ---------------------------------------------------------------------------
// Streamed-band contract (reliability remake)
// ---------------------------------------------------------------------------
// Every ledger-backed band on this view receives its data as a
// `Promise<SafeQueryResult<T>> | null` instead of a pre-unwrapped value:
//
//   • `null`            → the band's query was NOT kicked for the active
//                         tab (Active-Timeframe-Only) — render the skeleton;
//                         the URL-driven tab switch re-renders the server
//                         component which kicks it.
//   • promise resolves  → ALWAYS (safeQuery never rejects). `r.error`
//                         null → real data (or a genuine empty state);
//                         `r.error` set → the band renders a VISIBLE amber
//                         error (InlineError / BandError), never a silent
//                         empty that masquerades as "no data".
//
// Because the promises never reject, the `use()` sites need no client
// error boundaries — Suspense alone covers the pending state.

// ───────────────────────────────────────────────────────────────────
//  OVERVIEW TAB
// ───────────────────────────────────────────────────────────────────

export function OverviewTab({
  data,
  financialTxPromise,
  adjustmentsTxPromise,
  pnlResultPromise,
  wagerProgressPromise,
  isAdmin,
  viewerIsAdjustmentOwner,
}: {
  data: UserDetail;
  financialTxPromise: Promise<SafeQueryResult<PaginatedTransactions>> | null;
  // Per-user wager-requirement progress (always kicked server-side). Threaded
  // into the Deposits & Withdrawals popup so the wager-requirement status
  // shows on a deposit/withdrawal row. null when not kicked → popup self-hides.
  wagerProgressPromise: Promise<UserWagerProgress | null> | null;
  // Dedicated, UNCAPPED admin_balance_adjustment fetch (separate from the
  // shared 10-row `financialTx` page, which lumps adjustments together with
  // deposits/withdrawals/claims and can push an older adjustment off page 1
  // entirely). Surfacing it as its own input guarantees EVERY admin balance
  // adjustment reaches the dedicated adjustments block below, no matter how
  // much newer financial activity sits in front of it. Same query path, so
  // the official_stream fake-balance NOT-filter still applies automatically.
  // For a non-owner viewer the server hands a resolved empty page (the kick
  // is skipped; the server-side gate in getUserTransactions stays the
  // authority).
  adjustmentsTxPromise: Promise<SafeQueryResult<PaginatedTransactions>> | null;
  // Platform-P&L breakdown — feeds the Balance panel's pnl7d (Lossback
  // autofill) + the Platform P&L panel with its rolling ladder. Always
  // kicked by the server (hero risk/pnl are tab-independent).
  pnlResultPromise: Promise<SafeQueryResult<PnlBreakdown>>;
  isAdmin: boolean;
  // Owner-only flag (motha). Hides the dedicated adjustments block + the
  // adjustment filter option for non-owners. The server already strips the
  // rows for non-owners; this is defence-in-depth UI hygiene only.
  viewerIsAdjustmentOwner: boolean;
}) {
  const { user, statistics, counts, capabilities } = data;

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Modern stat panels — purpose-built to match the hero aesthetic:
          rounded-2xl, subtle colored corner glow, color-accented icon
          chip + hero number + breakdown rows below. items-stretch (with
          h-full on each StatPanel) so the three columns share one even
          height instead of the Platform-P&L panel towering over the
          others — its tall rolling-P&L ladder was removed for the same
          reason (it now lives only on the Account tab). The Balance +
          Platform-P&L panels are pnl-fed, so they stream as one Suspense
          cluster on pnlResultPromise; the Activity panel reads only the
          resolved detail aggregate and paints immediately. */}
      <div className="grid items-stretch gap-3 sm:gap-4 grid-cols-1 md:grid-cols-3">
        <Suspense
          fallback={
            <>
              <SkeletonCard lines={6} />
              <SkeletonCard lines={8} />
            </>
          }
        >
          <PnlFedPanelsStreamed data={data} pnlResultPromise={pnlResultPromise} />
        </Suspense>
        <ModernActivityPanel
          statistics={statistics}
          balances={data.balances}
          inventoryCount={data.inventoryCount}
          avgDeposit={counts.avgDeposit}
          userId={user.id}
          canAdjustXp={capabilities.canAdjustXp}
        />
      </div>

      {/* Deposits & Withdrawals — streamed so balance panels paint first. */}
      <SectionHeading icon={ArrowDownToLine} title="Deposits & Withdrawals" />
      {financialTxPromise ? (
        <Suspense fallback={<SkeletonTable rows={5} columns={6} />}>
          <DepositsWithdrawalsStreamed
            userId={user.id}
            cardWithdrawals={data.cardWithdrawals}
            financialTxPromise={financialTxPromise}
            isAdmin={isAdmin}
            canEditBalanceAdjustments={capabilities.canEditBalanceAdjustments}
            viewerIsAdjustmentOwner={viewerIsAdjustmentOwner}
            wagerProgressPromise={wagerProgressPromise}
          />
        </Suspense>
      ) : (
        <SkeletonTable rows={5} columns={6} />
      )}

      {/* Admin balance adjustments — OWNER ONLY (motha). Non-owner admins
          never see this block: the server already returns zero adjustment
          rows for them (so the block would self-hide anyway), but we also
          gate the render here so the section heading can't flash. Admin
          inventory removals/sales are written as admin_balance_adjustment
          rows ("Inventory removed: …"), so they surface HERE and in the
          Deposits & Withdrawals box above — like any other balance adjustment. */}
      {viewerIsAdjustmentOwner && adjustmentsTxPromise && (
        <Suspense fallback={null}>
          <AdminAdjustmentsStreamed
            userId={user.id}
            adjustmentsTxPromise={adjustmentsTxPromise}
            isAdmin={isAdmin}
            canEditBalanceAdjustments={capabilities.canEditBalanceAdjustments}
          />
        </Suspense>
      )}

      {/* Sponsored / free battles the user joined with no ledger row — these
          are otherwise invisible in gaming history. Self-fetching; hidden
          when none. */}
      <JoinedBattlesPanel userId={user.id} />

      {/* Tips & Rain — creator tips this user received/sent + rain
          prizes won. Sits directly below deposits per admin request
          (none of this was visible on any tab before). */}
      <SectionHeading icon={Coins} title="Tips & Rain" />
      <TipsSection tips={data.tips} />
    </div>
  );
}

// Balance + Platform-P&L panels — both fed by the P&L breakdown (pnl7d
// Lossback autofill / rolling ladder), so they `use()` the SafeQueryResult
// together. On a failed breakdown the Balance panel still renders its real
// balances (pnl7d simply doesn't autofill) while the Platform-P&L slot shows
// a VISIBLE band error instead of all-zero panels masquerading as "flat P&L".
function PnlFedPanelsStreamed({
  data,
  pnlResultPromise,
}: {
  data: UserDetail;
  pnlResultPromise: Promise<SafeQueryResult<PnlBreakdown>>;
}) {
  const r = use(pnlResultPromise);
  const { user, balances, capabilities } = data;
  return (
    <>
      <ModernBalancePanel
        balances={balances}
        userId={user.id}
        pnl7d={r.error ? undefined : r.data.pnl7d}
        canAdjustBalance={capabilities.canAdjustBalance}
        canRecordManualWithdrawal={capabilities.canRecordManualWithdrawal}
      />
      {r.error ? (
        <BandError
          title="Couldn't load Platform P&L"
          hint="The P&L breakdown failed or timed out — this is a load failure, not a flat P&L. Retry re-runs it."
        />
      ) : (
        <ModernPnlPanel balances={balances} pnlBreakdown={r.data} />
      )}
    </>
  );
}

// For a non-owner viewer the "admin balance adjustment" type must not even
// appear as a filter option in the Deposits & Withdrawals dropdown — the
// server already returns zero such rows, so dropping the label here just
// avoids surfacing the category name. The owner sees the full list.
const FINANCIAL_TX_TYPES_NO_ADJUSTMENTS = FINANCIAL_TX_TYPES.filter(
  (t) => t !== "admin_balance_adjustment",
);

function DepositsWithdrawalsStreamed({
  userId,
  cardWithdrawals,
  financialTxPromise,
  isAdmin,
  canEditBalanceAdjustments,
  viewerIsAdjustmentOwner,
  wagerProgressPromise,
}: {
  userId: string;
  cardWithdrawals: UserDetail["cardWithdrawals"];
  financialTxPromise: Promise<SafeQueryResult<PaginatedTransactions>>;
  isAdmin: boolean;
  canEditBalanceAdjustments: boolean;
  viewerIsAdjustmentOwner: boolean;
  // Always-kicked per-user wager-progress promise (same one the hero + Account
  // tab use). We project it to the compact serializable summary the
  // transaction-detail popup renders. null = not kicked → the popup block
  // self-hides. The wager read is timeout-wrapped server-side, so awaiting it
  // here can't hang this Suspense leg longer than the bound.
  wagerProgressPromise: Promise<UserWagerProgress | null> | null;
}) {
  const r = use(financialTxPromise);
  const wagerProgress = wagerProgressPromise ? use(wagerProgressPromise) : null;
  // Full type set for this table (adjustments included only for the owner).
  // The "All" segmented group carries it verbatim; Deposits / Withdrawals
  // carry their canonical subsets (defined in user-tabs-types.ts — no
  // invented type names). Selecting a group narrows BOTH the server query
  // and the Type dropdown; "All" restores the full feed.
  const financialTypes = viewerIsAdjustmentOwner
    ? FINANCIAL_TX_TYPES
    : FINANCIAL_TX_TYPES_NO_ADJUSTMENTS;
  return (
    <CategoryTransactionsTable
      title="Deposits & Withdrawals"
      userId={userId}
      types={financialTypes}
      groups={[
        { key: "all", label: "All", types: financialTypes },
        { key: "deposits", label: "Deposits", types: DEPOSIT_TX_TYPES },
        { key: "withdrawals", label: "Withdrawals", types: WITHDRAWAL_TX_TYPES },
      ]}
      initialTx={r.data}
      initialLoadError={r.error}
      cardWithdrawals={cardWithdrawals}
      isAdmin={isAdmin}
      canEditBalanceAdjustments={canEditBalanceAdjustments}
      wagerRequirement={toWagerRequirementSummary(wagerProgress)}
    />
  );
}

function AdminAdjustmentsStreamed({
  userId,
  adjustmentsTxPromise,
  isAdmin,
  canEditBalanceAdjustments,
}: {
  userId: string;
  adjustmentsTxPromise: Promise<SafeQueryResult<PaginatedTransactions>>;
  isAdmin: boolean;
  canEditBalanceAdjustments: boolean;
}) {
  const r = use(adjustmentsTxPromise);
  // Load failure → a VISIBLE compact error card. The owner must be able to
  // tell "no adjustments exist" (genuine empty → block self-hides below)
  // from "the adjustments query failed" — silently self-hiding on failure
  // would hide real adjustments behind a transient error.
  if (r.error) {
    return (
      <>
        <SectionHeading icon={Coins} title="Admin balance adjustments" />
        <InlineError
          compact
          title="Couldn't load admin balance adjustments"
          hint="This is a load failure, not an empty history — retry to re-run the query."
        />
      </>
    );
  }
  const adjustmentsTx = r.data;
  if (adjustmentsTx.total <= 0) return null;
  const mothaOnly = isMothaOnlyAdjustmentsProfile(userId);
  return (
    <>
      <SectionHeading icon={Coins} title="Admin balance adjustments" />
      {mothaOnly ? (
        <p className="text-xs text-muted-foreground -mt-2 mb-1">
          Motha adjustments only — other admins&apos; balance changes are hidden on this profile.
        </p>
      ) : null}
      <CategoryTransactionsTable
        title="Admin balance adjustments"
        userId={userId}
        types={ADJUSTMENT_TX_TYPES}
        initialTx={adjustmentsTx}
        isAdmin={isAdmin}
        canEditBalanceAdjustments={canEditBalanceAdjustments}
      />
    </>
  );
}

// ───────────────────────────────────────────────────────────────────
//  TIPS & RAIN SECTION (overview) — creator tips received/sent + rain
//  prizes won + affiliate-leaderboard wins + race prize claims
// ───────────────────────────────────────────────────────────────────

function TipsSection({ tips }: { tips: UserDetail["tips"] }) {
  return (
    <div className="grid gap-3 sm:gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
      <TipPanel kind="received" data={tips.received} />
      <TipPanel kind="sent" data={tips.sent} />
      <TipPanel kind="rain" data={tips.rainPrizes} />
      <TipPanel kind="race" data={tips.raceClaims} />
      <TipPanel kind="leaderboard" data={tips.leaderboardWins} />
    </div>
  );
}

function labelForRaceType(raceType: string): string {
  if (raceType === "daily") return "Daily race";
  if (raceType === "weekly") return "Weekly race";
  if (raceType === "monthly") return "Monthly race";
  return raceType.charAt(0).toUpperCase() + raceType.slice(1) + " race";
}

// `recent` is widened to the leaderboard variant since `LeaderboardWinEntry`
// extends `TipEntry` — the panel renders the extra fields only when
// kind === "leaderboard" (the only variant that carries them).
function TipPanel({
  kind,
  data,
}: {
  kind: "received" | "sent" | "rain" | "race" | "leaderboard";
  data: {
    count: number;
    totalUsd: number;
    recent: TipEntry[] | LeaderboardWinEntry[] | RaceClaimEntry[];
  };
}) {
  // House-POV (CLAUDE.md): money the user GAINS (tips received, rain
  // prizes, leaderboard wins) → house loss → rose. Money the user
  // SPENDS (tips sent) → house gain → emerald.
  const userGained = kind !== "sent";
  const amountColor = userGained
    ? "text-rose-600 dark:text-rose-400"
    : "text-emerald-600 dark:text-emerald-400";
  const accentChip = userGained
    ? "bg-rose-500/15 text-rose-500"
    : "bg-emerald-500/15 text-emerald-500";
  const Icon =
    kind === "received"
      ? ArrowDownToLine
      : kind === "sent"
        ? ArrowUpRight
        : kind === "rain"
          ? Trophy
          : kind === "race"
            ? Flag
            : Award;
  const label =
    kind === "received"
      ? "Tips Received"
      : kind === "sent"
        ? "Tips Sent"
        : kind === "rain"
          ? "Rain Prizes"
          : kind === "race"
            ? "Race Claims"
            : "Leaderboard Wins";
  const unit =
    kind === "rain"
      ? "prize"
      : kind === "race"
        ? "claim"
        : kind === "leaderboard"
          ? "win"
          : "tip";
  const emptyText =
    kind === "received"
      ? "No tips received."
      : kind === "sent"
        ? "No tips sent."
        : kind === "rain"
          ? "No rain prizes won."
          : kind === "race"
            ? "No race prizes claimed."
            : "No leaderboard wins.";
  const sign = userGained ? "+" : "-";

  return (
    <Card>
      <CardContent className="space-y-3 p-4 sm:p-5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-lg",
                accentChip,
              )}
            >
              <Icon className="size-4" />
            </span>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {label}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {data.count} {data.count === 1 ? unit : `${unit}s`}
              </p>
            </div>
          </div>
          <p className={cn("text-lg font-bold tabular-nums", amountColor)}>
            {data.count > 0
              ? `${sign}${formatCurrency(data.totalUsd)}`
              : formatCurrency(0)}
          </p>
        </div>

        {data.recent.length === 0 ? (
          <p className="text-xs text-muted-foreground">{emptyText}</p>
        ) : (
          <ul className="space-y-1.5">
            {data.recent.map((t) => {
              // Leaderboard rows carry source-leaderboard metadata
              // (id / title / position). Narrow once per row so the
              // rest of the JSX can read the extra fields without
              // re-asserting the type on each access.
              const lb =
                kind === "leaderboard"
                  ? (t as LeaderboardWinEntry)
                  : null;
              const race =
                kind === "race" ? (t as RaceClaimEntry) : null;
              const leaderboardHref = lb?.leaderboardId
                ? `/creators/leaderboards/${lb.leaderboardId}`
                : null;
              return (
                <li
                  key={t.id}
                  className="flex items-start justify-between gap-2 text-xs"
                >
                  <span className="min-w-0 flex-1 text-muted-foreground">
                    {kind === "rain" ? (
                      <span className="block truncate text-foreground">
                        Rain prize
                        <span className="ml-1 text-muted-foreground/70">
                          · <RelativeTime date={t.createdAt} />
                        </span>
                      </span>
                    ) : kind === "race" ? (
                      <span className="block">
                        <span className="block truncate text-foreground">
                          Race prize
                          {race?.position != null && (
                            <span className="ml-1 text-muted-foreground/80">
                              · #{race.position}
                            </span>
                          )}
                          <span className="ml-1 text-muted-foreground/70">
                            · <RelativeTime date={t.createdAt} />
                          </span>
                        </span>
                        {race?.raceType ? (
                          <Link
                            href="/rewards/leaderboards"
                            className="mt-0.5 block truncate text-[11px] font-medium text-foreground hover:text-primary hover:underline"
                          >
                            {labelForRaceType(race.raceType)}
                          </Link>
                        ) : null}
                      </span>
                    ) : kind === "leaderboard" ? (
                      // Stack: top line = static "Leaderboard win"
                      // label, second line = the source leaderboard
                      // (title + #rank). The second line is the
                      // clickable element so the meta-label up top
                      // doesn't visually compete with the link below.
                      <span className="block">
                        <span className="block truncate text-foreground">
                          Leaderboard win
                          {lb?.position != null && (
                            <span className="ml-1 text-muted-foreground/80">
                              · #{lb.position}
                            </span>
                          )}
                          <span className="ml-1 text-muted-foreground/70">
                            · <RelativeTime date={t.createdAt} />
                          </span>
                        </span>
                        {leaderboardHref ? (
                          <Link
                            href={leaderboardHref}
                            className="mt-0.5 block truncate text-[11px] font-medium text-foreground hover:text-primary hover:underline"
                            title={lb?.leaderboardTitle ?? undefined}
                          >
                            from{" "}
                            {lb?.leaderboardTitle ??
                              (lb?.leaderboardId
                                ? `${lb.leaderboardId.slice(0, 8)}…`
                                : "leaderboard")}
                          </Link>
                        ) : lb?.leaderboardTitle ? (
                          // Title resolved but no link target — show
                          // the title as plain text rather than
                          // hiding it.
                          <span className="mt-0.5 block truncate text-[11px] text-muted-foreground/80">
                            from {lb.leaderboardTitle}
                          </span>
                        ) : null}
                      </span>
                    ) : (
                      <span className="block truncate">
                        {kind === "received" ? "from " : "to "}
                        {t.counterpartyId ? (
                          <Link
                            href={`/users/${t.counterpartyId}`}
                            className="font-medium text-foreground hover:text-primary hover:underline"
                          >
                            {t.counterpartyName ?? t.counterpartyId.slice(0, 8)}
                          </Link>
                        ) : (
                          <span className="font-medium text-foreground">
                            unknown
                          </span>
                        )}
                        <span className="ml-1 text-muted-foreground/70">
                          · <RelativeTime date={t.createdAt} />
                        </span>
                      </span>
                    )}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 font-medium tabular-nums",
                      amountColor,
                    )}
                  >
                    {sign}
                    {formatCurrency(t.amountUsd)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// ───────────────────────────────────────────────────────────────────
//  REWARDS TAB
// ───────────────────────────────────────────────────────────────────

export function RewardsTab({
  rewardsPromise,
  rewardPackOpensPromise,
}: {
  rewardsPromise: Promise<SafeQueryResult<UserRewards>> | null;
  // Reward / sign-up pack opens (welcome/level/daily packs) + the cards they
  // granted. null = not kicked for the active tab (Active-Timeframe-Only).
  rewardPackOpensPromise: Promise<
    SafeQueryResult<UserRewardPackOpensResult>
  > | null;
}) {
  return (
    <div className="space-y-6">
      <SectionHeading icon={Gift} title="Rewards" />
      {rewardsPromise ? (
        <Suspense fallback={<SkeletonCard lines={4} />}>
          <RewardsStreamed rewardsPromise={rewardsPromise} />
        </Suspense>
      ) : (
        <SkeletonCard lines={4} />
      )}

      {/* Reward / sign-up pack opens — the provenance trail for cards granted
          by a reward pack (welcome pack, level packs, daily/free packs). A
          reward pack is an inventory giveaway with NO ledger grant row, so this
          is the only place an admin can see where these cards came from.
          Streamed; self-hides when the user has no reward-pack inventory. */}
      <RewardPackOpensSection
        rewardPackOpensPromise={rewardPackOpensPromise}
      />
    </div>
  );
}

function RewardsStreamed({
  rewardsPromise,
}: {
  rewardsPromise: Promise<SafeQueryResult<UserRewards>>;
}) {
  const r = use(rewardsPromise);
  if (r.error) {
    return (
      <InlineError
        compact
        title="Couldn't load rewards"
        hint="This is a load failure, not an empty rewards history — retry to re-run the query."
      />
    );
  }
  return <RewardsCard rewards={r.data} />;
}

// ───────────────────────────────────────────────────────────────────
//  FINANCES TAB
// ───────────────────────────────────────────────────────────────────

export function FinancesTab({
  data,
  financialTxPromise,
  xpPurchasesPromise,
  wagerProgressPromise,
  isAdmin,
  viewerIsAdjustmentOwner,
}: {
  data: UserDetail;
  financialTxPromise: Promise<SafeQueryResult<PaginatedTransactions>> | null;
  // Per-user XP purchases (USD balance spent to buy XP). null = not kicked
  // for the active tab. The section self-hides when the user bought no XP.
  xpPurchasesPromise: Promise<SafeQueryResult<UserXpPurchasesResult>> | null;
  // Per-user wager-requirement progress (always kicked server-side). Threaded
  // into the Deposits & Withdrawals popup so the wager-requirement status
  // shows on a deposit/withdrawal row. null when not kicked → popup self-hides.
  wagerProgressPromise: Promise<UserWagerProgress | null> | null;
  isAdmin: boolean;
  viewerIsAdjustmentOwner: boolean;
}) {
  const { user, capabilities } = data;
  return (
    <div className="space-y-6">
      <SectionHeading icon={ArrowDownToLine} title="Deposits & Withdrawals" />
      {financialTxPromise ? (
        <Suspense fallback={<SkeletonTable rows={5} columns={6} />}>
          <DepositsWithdrawalsStreamed
            userId={user.id}
            cardWithdrawals={data.cardWithdrawals}
            financialTxPromise={financialTxPromise}
            isAdmin={isAdmin}
            canEditBalanceAdjustments={capabilities.canEditBalanceAdjustments}
            viewerIsAdjustmentOwner={viewerIsAdjustmentOwner}
            wagerProgressPromise={wagerProgressPromise}
          />
        </Suspense>
      ) : (
        <SkeletonTable rows={5} columns={6} />
      )}

      {/* XP purchases (USD balance spent to buy XP) — streamed so the read
          never blocks the table above; self-hides when the user bought no
          XP. House-POV: the spend is a house gain (emerald). */}
      <Suspense fallback={null}>
        <XpPurchasesSection xpPurchasesPromise={xpPurchasesPromise} />
      </Suspense>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────
//  GAMING TAB
// ───────────────────────────────────────────────────────────────────

export function GamingTab({
  data,
  gamingTxPromise,
  shardWinningsPromise,
  shardPackOpensPromise,
  doubleDownPromise,
}: {
  data: UserDetail;
  gamingTxPromise: Promise<SafeQueryResult<PaginatedTransactions>> | null;
  // Per-user shard/coin winnings tagged by source game. null = not kicked
  // for the active tab (Active-Timeframe-Only). The section self-hides when
  // the connected DB has no coin_transactions table or the user has none.
  shardWinningsPromise: Promise<SafeQueryResult<ShardWinningsResult>> | null;
  // Per-user shard-PACK opens (shards spent + value won, both in shards),
  // diamond-tagged. null = not kicked for the active tab. Self-hides when
  // the connected DB has no coin ledger or the user never opened a shard pack.
  shardPackOpensPromise: Promise<SafeQueryResult<ShardPackOpensResult>> | null;
  // Per-user Double Down (gamble-your-battle-winnings) history. null = not
  // kicked for the active tab (Active-Timeframe-Only). The section self-hides
  // when the user has had no Double Down rounds.
  doubleDownPromise: Promise<SafeQueryResult<UserDoubleDownHistory>> | null;
}) {
  const { user } = data;
  // sessionRole drives the password-aware Watch button + password-reveal
  // row inside the transaction-detail modal. The shared UserDetail
  // already carries sessionRole resolved server-side in page.tsx, so the
  // gate is single-sourced and matches every other admin-only affordance
  // on this view (e.g. the password row on /battles/[id]).
  const isAdmin = data.sessionRole === "admin";
  return (
    <div className="space-y-6">
      <SectionHeading icon={Swords} title="Gaming Transactions" />
      {gamingTxPromise ? (
        <Suspense fallback={<SkeletonTable rows={5} columns={6} />}>
          <GamingTransactionsStreamed
            userId={user.id}
            gamingTxPromise={gamingTxPromise}
            isAdmin={isAdmin}
          />
        </Suspense>
      ) : (
        <SkeletonTable rows={5} columns={6} />
      )}

      {/* Shard PACK opens (packs bought with shards, not USD) — diamond-
          tagged, showing shards spent + value won (both in shards). Streamed
          so the coin-ledger read never blocks the USD table above; self-hides
          when there are no shard pack opens (or no coin ledger on the
          connected DB). */}
      <Suspense fallback={null}>
        <ShardPackOpensSection shardPackOpensPromise={shardPackOpensPromise} />
      </Suspense>

      {/* Shard/coin winnings (secondary currency) tagged by source game.
          Streamed so the coin-ledger read never blocks the USD table above;
          self-hides when there are no shard winnings (or no coin ledger on
          the connected DB). */}
      <Suspense fallback={null}>
        <ShardWinningsSection shardWinningsPromise={shardWinningsPromise} />
      </Suspense>

      {/* Double Down (gamble-your-battle-winnings) history — this user's
          rounds as a House-POV log + summary. Streamed so the indexed
          per-user lookup never blocks the tables above; self-hides when the
          user has had no Double Down rounds. */}
      <Suspense fallback={null}>
        <DoubleDownSection doubleDownPromise={doubleDownPromise} />
      </Suspense>

      {/* Sponsored / free battles joined — these have no battle_bet ledger
          row so they never appear in the Gaming Transactions table above.
          Surfaced here so free battles + their winnings are accounted for. */}
      <JoinedBattlesPanel userId={user.id} />
    </div>
  );
}

function GamingTransactionsStreamed({
  userId,
  gamingTxPromise,
  isAdmin,
}: {
  userId: string;
  gamingTxPromise: Promise<SafeQueryResult<PaginatedTransactions>>;
  isAdmin: boolean;
}) {
  const r = use(gamingTxPromise);
  return (
    <CategoryTransactionsTable
      title="Gaming"
      userId={userId}
      types={GAMING_TX_TYPES}
      initialTx={r.data}
      initialLoadError={r.error}
      showCardsValue
      isAdmin={isAdmin}
    />
  );
}

// ───────────────────────────────────────────────────────────────────
//  INVENTORY TAB
// ───────────────────────────────────────────────────────────────────

export function InventoryTab({
  data,
  inventoryPromise,
  disposedInventoryPromise,
  cardSaleTxPromise,
  battleVoucherTxPromise,
}: {
  data: UserDetail;
  // Both inventory pages are tab-gated reads (kicked only when ?tab=
  // inventory is active — Active-Timeframe-Only). The hero's inventory /
  // voucher VALUES come from `balances` inside the detail aggregate, so
  // moving the owned page out of the body gate costs the hero nothing.
  inventoryPromise: Promise<SafeQueryResult<PaginatedInventory>> | null;
  disposedInventoryPromise: Promise<SafeQueryResult<PaginatedInventory>> | null;
  // Card-sale cash-out ledger (card_sale / reward_card_sale) — moved here off
  // the Gaming tab per owner. Same tab-gated contract: null = not kicked
  // (Active-Timeframe-Only) → skeleton until the URL-driven re-render kicks it.
  cardSaleTxPromise: Promise<SafeQueryResult<PaginatedTransactions>> | null;
  // Battle-win voucher GRANT ledger (battle_excess_to_voucher) — moved here off
  // the Gaming tab per owner (the paired battle_bet row already shows the full
  // win P&L). Same tab-gated contract as cardSaleTxPromise: null = not kicked.
  battleVoucherTxPromise: Promise<SafeQueryResult<PaginatedTransactions>> | null;
}) {
  const { user } = data;
  const isAdmin = data.sessionRole === "admin";
  return (
    <div className="space-y-6">
      <SectionHeading icon={Gem} title="Current Inventory" />
      {inventoryPromise ? (
        <Suspense fallback={<SkeletonTable rows={4} columns={6} />}>
          <OwnedInventoryStreamed data={data} inventoryPromise={inventoryPromise} />
        </Suspense>
      ) : (
        <SkeletonTable rows={4} columns={6} />
      )}
      <UserVouchersPanel
        userId={user.id}
        canRemove={data.capabilities.canAdjustBalance}
      />
      <SectionHeading icon={Trophy} title="Sold & Exchanged" />
      {disposedInventoryPromise ? (
        <Suspense fallback={<SkeletonTable rows={5} columns={5} />}>
          <DisposedCardsStreamed
            userId={user.id}
            disposedInventoryPromise={disposedInventoryPromise}
          />
        </Suspense>
      ) : (
        <SkeletonTable rows={5} columns={5} />
      )}

      {/* Item cash-outs — selling a won (card_sale) or reward
          (reward_card_sale) card back to balance, OR cashing a won voucher back
          to balance (voucher_redeemed). These realize a held item into cash
          (voucher == card per house rules), so they sit with the items they
          came from (moved off the Gaming tab per owner). Streamed on the
          tab-gated promise. */}
      <SectionHeading icon={Banknote} title="Card & Voucher Sales" />
      {cardSaleTxPromise ? (
        <Suspense fallback={<SkeletonTable rows={5} columns={6} />}>
          <CardSalesStreamed
            userId={user.id}
            cardSaleTxPromise={cardSaleTxPromise}
            isAdmin={isAdmin}
          />
        </Suspense>
      ) : (
        <SkeletonTable rows={5} columns={6} />
      )}

      {/* Battle-win voucher GRANTS — battle_excess_to_voucher, the leftover
          voucher leg of a battle win (voucher == card per house rules). This is
          a win-GRANT of a held item, not a sale/cash-out, so it sits in its own
          section rather than diluting "Card & Voucher Sales". Moved off the
          Gaming tab per owner (the paired battle_bet row already shows the full
          win P&L). Same tab-gated streaming contract as the sales section. */}
      <SectionHeading icon={Swords} title="Battle Win Vouchers" />
      {battleVoucherTxPromise ? (
        <Suspense fallback={<SkeletonTable rows={4} columns={6} />}>
          <BattleVouchersStreamed
            userId={user.id}
            battleVoucherTxPromise={battleVoucherTxPromise}
            isAdmin={isAdmin}
          />
        </Suspense>
      ) : (
        <SkeletonTable rows={4} columns={6} />
      )}
    </div>
  );
}

// `use()`s the streamed battle-win voucher-grant ledger page and renders the
// shared CategoryTransactionsTable with the battle_excess_to_voucher allow-list.
// Reusing the table keeps the "Battle win — voucher" label + the per-row
// battle Watch-button association intact in the inventory context. error ≠
// empty — a load error surfaces visibly instead of a false "no vouchers".
function BattleVouchersStreamed({
  userId,
  battleVoucherTxPromise,
  isAdmin,
}: {
  userId: string;
  battleVoucherTxPromise: Promise<SafeQueryResult<PaginatedTransactions>>;
  isAdmin: boolean;
}) {
  const r = use(battleVoucherTxPromise);
  return (
    <CategoryTransactionsTable
      title="Battle Win Vouchers"
      userId={userId}
      types={BATTLE_VOUCHER_TX_TYPES}
      initialTx={r.data}
      initialLoadError={r.error}
      showCardsValue
      isAdmin={isAdmin}
    />
  );
}

// `use()`s the streamed card-sale ledger page and renders the shared
// CategoryTransactionsTable with the card-sale type allow-list. error ≠ empty —
// the table surfaces a VISIBLE load error instead of a false "no sales".
function CardSalesStreamed({
  userId,
  cardSaleTxPromise,
  isAdmin,
}: {
  userId: string;
  cardSaleTxPromise: Promise<SafeQueryResult<PaginatedTransactions>>;
  isAdmin: boolean;
}) {
  const r = use(cardSaleTxPromise);
  return (
    <CategoryTransactionsTable
      title="Card & Voucher Sales"
      userId={userId}
      types={CARD_SALE_TX_TYPES}
      initialTx={r.data}
      initialLoadError={r.error}
      showCardsValue
      isAdmin={isAdmin}
    />
  );
}

// `use()`s the streamed owned-inventory result and renders the unchanged
// <InventoryGrid> with the resolved page + its load error (error ≠ empty —
// the grid shows an InlineError instead of "No items in inventory" when the
// seeding query failed).
function OwnedInventoryStreamed({
  data,
  inventoryPromise,
}: {
  data: UserDetail;
  inventoryPromise: Promise<SafeQueryResult<PaginatedInventory>>;
}) {
  const r = use(inventoryPromise);
  const { user, balances } = data;
  return (
    <InventoryGrid
      userId={user.id}
      initialInventory={r.data}
      initialLoadError={r.error}
      inventoryValue={balances?.inventoryValue ?? 0}
      vouchersValue={balances?.vouchersValue ?? 0}
      statusFilter="owned"
      canDeleteInventory={data.capabilities.canAdjustBalance}
    />
  );
}

// Thin wrapper that `use()`s the streamed disposed-inventory result and
// renders the unchanged <DisposedCardsTable> with the resolved page + its
// load error — only the await point moved off the critical path.
function DisposedCardsStreamed({
  userId,
  disposedInventoryPromise,
}: {
  userId: string;
  disposedInventoryPromise: Promise<SafeQueryResult<PaginatedInventory>>;
}) {
  const r = use(disposedInventoryPromise);
  return (
    <DisposedCardsTable
      userId={userId}
      initialInventory={r.data}
      initialLoadError={r.error}
    />
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

      {/* Two visually distinct sections — each manages DIFFERENT
          columns on the user table:
            • ReferrerCard ↓ writes user.referred_by (who referred them
              in) AND user.affiliate_code/_active (the code they're on
              right now → where wager affiliate income routes).
            • OwnCodeCard  → writes the affiliate_codes table (the codes
              this user OWNS to hand out).
          The labels and panel styling are deliberately different so
          admins can't confuse the two — the previous "Referral Code
          Used" / "Own Affiliate Code" naming was too symmetric. */}
      <SectionHeading
        icon={ArrowDownToLine}
        title="Joined Under (Referrer)"
      />
      <ReferrerCard user={user} />

      {/* Attribution journey — the codes this user hopped through over
          time + the economics booked under each. Lazy-loaded on mount so
          it never burdens the always-rendered page payload. Sits right
          under the referrer card because it's the same side of the
          relationship: how THIS user was attributed to creators (not the
          codes they own, which the next section covers). */}
      <SectionHeading icon={Waypoints} title="Attribution Journey" />
      <AttributionJourneySection userId={user.id} />

      <SectionHeading icon={Sparkles} title="Their Own Affiliate Code" />
      <OwnCodeCard user={user} affiliate={affiliate} />

      {/* Section 3: Stats — only render if the affiliate_accounts row exists */}
      {affiliate && (
        <>
          <SectionHeading icon={TrendingUp} title="Affiliate Stats" />
          <div className="grid gap-3 sm:gap-4 grid-cols-2 lg:grid-cols-3">
            <ModernMetricTile
              label="Total Referred"
              value={formatNumber(affiliate.totalReferred)}
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

// ───────────────────────────────────────────────────────────────────
//  ATTRIBUTION JOURNEY — the codes this user hopped through over time,
//  with per-code deposits + wager. Sourced from affiliate_code_usages
//  (the SAME canonical attribution table the /creators surfaces read),
//  grouped by code for this one user, ordered chronologically.
//
//  House-POV colors (CLAUDE.md): deposits = capital flowing IN → emerald;
//  wager = the user risking their money → emerald. Both are house-gain
//  side, so both render emerald (NOT the user-perspective green/red).
// ───────────────────────────────────────────────────────────────────

function AttributionJourneySection({ userId }: { userId: string }) {
  const [state, setState] = useState<{
    status: "loading" | "ready" | "error";
    rows: AttributionJourneyEntry[];
    error: string | null;
  }>({ status: "loading", rows: [], error: null });

  // Lazy-load on mount. The affiliate tab only renders when active
  // (parent gates `activeTab === "affiliate"`), so this fires exactly
  // when the section becomes visible — no eager work on the other tabs.
  React.useEffect(() => {
    let alive = true;
    fetchUserAttributionJourney(userId)
      .then((res) => {
        if (!alive) return;
        setState({
          status: res.error ? "error" : "ready",
          rows: res.data,
          error: res.error,
        });
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setState({
          status: "error",
          rows: [],
          error: e instanceof Error ? e.message : "Failed to load journey",
        });
      });
    return () => {
      alive = false;
    };
  }, [userId]);

  if (state.status === "loading") {
    return (
      <Card>
        <CardContent className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading attribution journey…
        </CardContent>
      </Card>
    );
  }

  if (state.status === "error") {
    return (
      <Card>
        <CardContent className="p-4 sm:p-6">
          <p className="text-sm text-muted-foreground">
            Couldn&apos;t load the attribution journey
            {state.error ? ` (${state.error})` : ""}.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (state.rows.length === 0) {
    return (
      <Card>
        <CardContent className="p-0">
          <EmptyState
            icon={Waypoints}
            title="No code attribution yet"
            description="This user hasn't used any affiliate / creator code. Codes they enter (and the deposits + wager booked under each) will appear here in the order they used them."
            compact
          />
        </CardContent>
      </Card>
    );
  }

  // Journey totals across every code the user passed through — gives the
  // admin the headline before the per-code breakdown. Both emerald
  // (house-gain side per the section's color note).
  const totalDeposits = state.rows.reduce(
    (acc, r) => acc + r.depositAmountUsd,
    0,
  );
  const totalWager = state.rows.reduce((acc, r) => acc + r.wagerAmountUsd, 0);
  const codeCount = state.rows.length;

  return (
    <div className="space-y-3 sm:space-y-4">
      {/* Headline strip — distinct-codes count + lifetime deposits/wager
          booked across the whole journey. */}
      <div className="grid gap-3 sm:gap-4 grid-cols-1 sm:grid-cols-3">
        <ModernMetricTile
          label="Codes Used"
          value={formatNumber(codeCount)}
          accent={codeCount >= 2 ? "amber" : "purple"}
          icon={Waypoints}
        />
        <ModernMetricTile
          label="Deposited Under Codes"
          value={formatCurrency(totalDeposits)}
          accent="emerald"
          icon={ArrowDownToLine}
        />
        <ModernMetricTile
          label="Wagered Under Codes"
          value={formatCurrency(totalWager)}
          accent="emerald"
          icon={CoinsIcon}
        />
      </div>

      {/* Per-code timeline. Ordered chronologically (oldest first) so the
          list reads as the actual hop sequence. The leading index + the
          "switched" caption on rows past the first make the code-hopping
          explicit. */}
      <Card>
        <CardContent className="p-0">
          <ul className="divide-y divide-border">
            {state.rows.map((row, i) => {
              const isSwitch = i > 0;
              const sameDay = row.firstUsedAt.slice(0, 10) ===
                row.lastUsedAt.slice(0, 10);
              return (
                <li
                  key={`${row.code}-${row.firstUsedAt}`}
                  className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5"
                >
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold tabular-nums text-primary">
                      {i + 1}
                    </span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-sm font-semibold">
                          {row.code}
                        </span>
                        <Link
                          href={`/creators/${row.creatorUserId}`}
                          className="text-xs text-blue-500 hover:underline"
                        >
                          {row.creatorName ??
                            `${row.creatorUserId.slice(0, 8)}…`}
                        </Link>
                        {isSwitch && (
                          <Badge
                            variant="outline"
                            className="border-amber-500/30 bg-amber-500/15 text-[10px] text-amber-600 dark:text-amber-400"
                          >
                            switched
                          </Badge>
                        )}
                      </div>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        {sameDay ? (
                          <>Used {formatDateTime(row.firstUsedAt)}</>
                        ) : (
                          <>
                            {formatDateTime(row.firstUsedAt)} →{" "}
                            {formatDateTime(row.lastUsedAt)}
                          </>
                        )}
                        <span className="ml-1 text-muted-foreground/70">
                          · <RelativeTime date={row.firstUsedAt} />
                        </span>
                      </p>
                      {row.lastAppliedAt && (
                        <p className="mt-0.5 text-[11px] text-muted-foreground">
                          Last applied:{" "}
                          <span className="font-medium text-foreground/80">
                            {formatDateTime(row.lastAppliedAt)}
                          </span>
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Per-code economics. Deposits + wager both emerald
                      (house-gain side). Aligned right on desktop, stacked
                      under the code on phones. */}
                  <div className="flex shrink-0 items-center gap-5 pl-10 sm:pl-0">
                    <div className="text-right">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Deposited
                      </p>
                      <p className="text-sm font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
                        {formatCurrency(row.depositAmountUsd)}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Wagered
                      </p>
                      <p className="text-sm font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
                        {formatCurrency(row.wagerAmountUsd)}
                      </p>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Referrer card — sets the code this user is on, via a code lookup ─
//
// Admins enter a code (someone else's affiliate code); the action looks
// up the owner and writes BOTH:
//   • user.referred_by = owner.id           (permanent attribution)
//   • user.affiliate_code = code, _active=true, _expires_at=null
//     (the ACTIVE code → routes WAGER affiliate income to the owner;
//      no frontend lock so the user can still change it on the site)
// and bumps that owner's affiliate_accounts.total_referred. Setting
// referred_by alone does NOT move wager income — affiliate_code is the
// live routing field — which is why this card writes both.
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
        toast.success(
          `Code "${trimmed}" set — wager income now routes to its owner`,
        );
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
        toast.success(
          "Referral removed — future wagers won't route to this code",
        );
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
  const canClearReferral = hasFormalReferrer || hasCarriedCookie;

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
                    background so it reads as a token, not body text.
                    Clickable: navigates to the code owner's profile
                    (same target as the @username link beside it) so
                    admins can click either side to drill in. */}
                {user.referredByCode ? (
                  <Link
                    href={`/users/${user.referredBy}`}
                    aria-label={`Open profile of ${user.referredByUsername ?? user.referredBy?.slice(0, 8)} (owner of ${user.referredByCode})`}
                    className="rounded-md bg-blue-500/15 px-2 py-1 font-mono text-sm font-semibold text-blue-700 transition-colors hover:bg-blue-500/25 dark:text-blue-300"
                  >
                    {user.referredByCode}
                  </Link>
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
                  Remove referral
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
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto h-7 gap-1.5 text-xs text-rose-500 border-rose-500/40 hover:bg-rose-500/10"
                  onClick={() => setConfirmClearOpen(true)}
                  disabled={isPending}
                >
                  Remove code
                </Button>
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
              ? "Change the code this user is on (routes wager income)"
              : "Set the code this user is on (routes wager income)"}
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
            ⚠ This sets the user&apos;s{" "}
            <span className="font-mono">referred_by</span> (who referred
            them in) <span className="font-semibold">and</span> their
            active <span className="font-mono">affiliate_code</span> — so
            their <span className="font-semibold">wager affiliate income
            routes to this code&apos;s owner</span>. No frontend lock is
            applied (it replaces any pending 1h lock; the user can still
            change it on the site). The code must already be owned by
            another user. To give THIS user their own code to hand out
            instead, use the section below.
          </p>
        </div>
      </CardContent>

      <AlertDialog open={confirmClearOpen} onOpenChange={setConfirmClearOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove referral code?</AlertDialogTitle>
            <AlertDialogDescription>
              {hasFormalReferrer ? (
                <>
                  Removes this user&apos;s{" "}
                  <span className="font-mono">referred_by</span> link and
                  clears their active{" "}
                  <span className="font-mono">affiliate_code</span>, so{" "}
                  <span className="font-semibold">
                    future wagers stop routing affiliate income
                  </span>{" "}
                  to the old code owner. Decrements the previous
                  referrer&apos;s{" "}
                  <span className="font-mono">total_referred</span> counter.
                </>
              ) : (
                <>
                  Clears the referral cookie (
                  <span className="font-mono">{carriedCookie}</span>) from
                  this profile so{" "}
                  <span className="font-semibold">
                    future wagers won&apos;t count toward that code
                  </span>{" "}
                  if they deposit later. No formal{" "}
                  <span className="font-mono">referred_by</span> link exists
                  yet.
                </>
              )}{" "}
              Historical{" "}
              <span className="font-mono">affiliate_code_usages</span> rows
              are kept as an audit trail — only live routing is removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleClear}
              disabled={isPending || !canClearReferral}
              className="bg-rose-500 hover:bg-rose-500/90"
            >
              {isPending ? "Removing…" : "Remove referral"}
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
      : `/users/${userId}`;
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
        added <RelativeTime date={createdAt} />
      </span>
    </Link>
  );
}

// ───────────────────────────────────────────────────────────────────
//  FUNDS TAB — money-provenance trace
//
//  Answers two operator questions on one surface, now that the platform
//  runs a custom sweepstakes funds system:
//    1. WHERE did this user's money come from? (deposits vs house-given
//       bonus / affiliate / rakeback / tips — per-source lifetime + the
//       portion still locked behind the wager requirement)
//    2. WHICH wager does it carry? (the withdrawal wager-requirement
//       progress + per-source contribution — reuses UserWagerProgressCard)
//
//  Data sources (all already resolved / kicked — no new tab-gated read):
//    • data.balances        → available / locked / deposited / withdrawn /
//                             wagered / won / shards / coin balance
//    • wagerProgressPromise → the per-source provenance + locked split +
//                             requirement progress (always-kicked promise,
//                             shared with the hero "Wager Left" tile +
//                             Account tab). null = prod / no-balance / read
//                             failed → the card's muted "not available".
//
//  House-POV colors (CLAUDE.md): user-held / user-owed money (available
//  balance, locked, withdrawable, winnings, house-given source funds) →
//  ROSE; deposits flowing in → EMERALD; neutral info (shards, requirement
//  counts) → CYAN / BLUE.
// ───────────────────────────────────────────────────────────────────

export function FundsTab({
  data,
  wagerProgressPromise,
}: {
  data: UserDetail;
  // Always-kicked read of the per-source provenance + wager progress. null
  // promise only when the page hasn't kicked it (it always does today); a
  // resolved null = prod / no-balance / read failed → muted not-available.
  wagerProgressPromise: Promise<UserWagerProgress | null> | null;
}) {
  return (
    <div className="space-y-6">
      <SectionHeading icon={Wallet} title="Balance Now" />
      {/* The KPI row + provenance + which-wager sections all read the same
          wager-progress promise (for locked / sources / requirement), so
          they stream together once it resolves. data.balances is already
          resolved, so the balance figures paint as soon as the promise does. */}
      {wagerProgressPromise ? (
        <Suspense fallback={<SkeletonCard lines={6} />}>
          <FundsTraceStreamed
            balances={data.balances}
            wagerProgressPromise={wagerProgressPromise}
            userId={data.user.id}
            canManage={data.sessionRole === "admin"}
          />
        </Suspense>
      ) : (
        <SkeletonCard lines={6} />
      )}
    </div>
  );
}

function FundsTraceStreamed({
  balances,
  wagerProgressPromise,
  userId,
  canManage,
}: {
  balances: UserDetail["balances"];
  wagerProgressPromise: Promise<UserWagerProgress | null>;
  userId: string;
  canManage: boolean;
}) {
  const wagerProgress = use(wagerProgressPromise);

  // Balance figures — straight from the resolved detail aggregate.
  const available = balances?.availableBalance ?? 0;
  const locked = wagerProgress?.totalLockedUsd ?? balances?.lockedBalance ?? 0;
  // Withdrawable = the available cash NOT gated behind the wager
  // requirement. Clamped ≥ 0 so a fully-locked balance reads $0.00, never
  // a negative. Approximation: the backend gates the whole balance until
  // the requirement is met, but the per-source locked split is the closest
  // read-only signal we have for "cash free to pull right now".
  const withdrawable = Math.max(0, available - locked);
  const deposited = balances?.totalDeposited ?? 0;
  const withdrawn = balances?.totalWithdrawn ?? 0;
  const wagered = balances?.totalWagered ?? 0;
  const won = balances?.totalWon ?? 0;
  const shards = wagerProgress?.shards ?? 0;

  return (
    <div className="space-y-6">
      {/* ── BALANCE NOW — KPI row ──────────────────────────────────────
          Available / Locked / Withdrawable are all user-held or user-owed
          money → rose. Shards are neutral secondary currency → cyan. */}
      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-4">
        <KpiTile
          icon={Wallet}
          label="Available"
          accent="rose"
          value={formatCurrency(available)}
          sub="cash balance"
        />
        <KpiTile
          icon={Lock}
          label="Locked"
          accent="rose"
          value={formatCurrency(locked)}
          sub="behind wager req."
        />
        <KpiTile
          icon={ArrowUpFromLine}
          label="Withdrawable"
          accent="rose"
          value={formatCurrency(withdrawable)}
          sub="free to pull now"
        />
        <KpiTile
          icon={Gem}
          label="Shards"
          accent="cyan"
          value={shards.toLocaleString("en-US")}
          sub="secondary currency"
        />
      </div>

      {/* ── FLOW LINE — Deposited → Wagered → Won → Balance → Withdrawable
          A compact left-to-right money story. Deposited / Wagered are the
          house-gain side (capital in / stake risked) → emerald; Won and the
          two balance figures are user-held → rose. Withdrawals shown as a
          caption on the balance node so the operator can read the realized
          cash-out leg too. */}
      <FundsFlowLine
        deposited={deposited}
        wagered={wagered}
        won={won}
        balance={available + locked}
        withdrawable={withdrawable}
        withdrawn={withdrawn}
      />

      {/* ── WHERE THE MONEY CAME FROM — provenance ─────────────────────
          Per-source lifetime received + still-locked, from the backend-
          written source columns. Deposits → emerald (capital in); every
          house-given source (bonus / affiliate / rakeback / tips) → rose. */}
      <SectionHeading icon={GitBranch} title="Where the Money Came From" />
      <FundsProvenanceCard wagerProgress={wagerProgress} />

      {/* ── WHICH WAGER — attribution ──────────────────────────────────
          The withdrawal wager-requirement progress + per-source
          contribution. Reuses the exact card the Account tab renders so the
          numbers can never drift between the two surfaces. */}
      <SectionHeading icon={TrendingUp} title="Which Wager It Carries" />
      <UserWagerProgressCard
        userId={userId}
        data={wagerProgress}
        canManage={canManage}
      />
    </div>
  );
}

// Compact money-flow strip: Deposited → Wagered → Won → On-site balance →
// Withdrawable, with arrows between nodes. House-POV colors per CLAUDE.md.
function FundsFlowLine({
  deposited,
  wagered,
  won,
  balance,
  withdrawable,
  withdrawn,
}: {
  deposited: number;
  wagered: number;
  won: number;
  balance: number;
  withdrawable: number;
  withdrawn: number;
}) {
  const nodes: {
    label: string;
    value: string;
    sub?: string;
    color: string;
  }[] = [
    {
      label: "Deposited",
      value: formatCurrency(deposited),
      color: "text-emerald-600 dark:text-emerald-400",
    },
    {
      label: "Wagered",
      value: formatCurrency(wagered),
      color: "text-emerald-600 dark:text-emerald-400",
    },
    {
      label: "Won",
      value: formatCurrency(won),
      color: "text-rose-600 dark:text-rose-400",
    },
    {
      label: "Balance",
      value: formatCurrency(balance),
      sub: withdrawn > 0 ? `${formatCurrency(withdrawn)} withdrawn` : undefined,
      color: "text-rose-600 dark:text-rose-400",
    },
    {
      label: "Withdrawable",
      value: formatCurrency(withdrawable),
      color: "text-rose-600 dark:text-rose-400",
    },
  ];
  return (
    <Card>
      <CardContent className="p-4 sm:p-5">
        <div className="flex flex-wrap items-stretch gap-2 sm:gap-1">
          {nodes.map((n, i) => (
            <React.Fragment key={n.label}>
              <div className="min-w-0 flex-1 basis-[7rem] rounded-lg border bg-muted/20 px-3 py-2 text-center">
                <p className="truncate text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {n.label}
                </p>
                <p className={cn("mt-0.5 truncate text-sm font-bold tabular-nums", n.color)}>
                  {n.value}
                </p>
                {n.sub && (
                  <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
                    {n.sub}
                  </p>
                )}
              </div>
              {i < nodes.length - 1 && (
                <div
                  aria-hidden
                  className="hidden shrink-0 items-center self-center text-muted-foreground/50 sm:flex"
                >
                  <ArrowRight className="size-4" />
                </div>
              )}
            </React.Fragment>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// Per-source provenance breakdown — lifetime received + still-locked per
// funding source. Deposits are the only emerald row (real capital the user
// brought in = house gain in the moment); the other four sources are money
// the HOUSE gave the user (bonus / affiliate / rakeback / tips) so they read
// rose (house-loss side per CLAUDE.md). The Locked column is always rose
// (user money we owe but is gated behind the wager requirement).
function FundsProvenanceCard({
  wagerProgress,
}: {
  wagerProgress: UserWagerProgress | null;
}) {
  if (!wagerProgress) {
    return (
      <Card className="border-dashed">
        <CardContent className="p-0">
          <EmptyState
            icon={GitBranch}
            title="Funds provenance not available"
            description="This user has no balance record, or the connected database doesn't carry the sweepstakes source columns — no per-source breakdown can be shown."
            compact
          />
        </CardContent>
      </Card>
    );
  }

  const { sources, totalLockedUsd } = wagerProgress;
  // Σ lifetime across every source — the denominator for the "share of
  // funds" read. Guard /0 so an all-zero user shows 0% not NaN%.
  const totalLifetime = sources.reduce((acc, s) => acc + s.lifetimeTotalUsd, 0);

  return (
    <StatPanel title="Funding sources" icon={Landmark} accent="blue">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-[11px] uppercase tracking-wider text-muted-foreground">
              <th className="py-1.5 pr-2 text-left font-medium">Source</th>
              <th className="px-2 py-1.5 text-right font-medium">Lifetime</th>
              <th className="px-2 py-1.5 text-right font-medium">Share</th>
              <th className="py-1.5 pl-2 text-right font-medium">Locked</th>
            </tr>
          </thead>
          <tbody>
            {sources.map((s) => {
              // Deposits = capital the user brought in → house-gain side →
              // emerald. Every other source is house-given money → rose.
              const isDeposit = s.key === "deposit";
              const lifetimeColor = isDeposit
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-rose-600 dark:text-rose-400";
              const share =
                totalLifetime > 0
                  ? (s.lifetimeTotalUsd / totalLifetime) * 100
                  : 0;
              return (
                <tr
                  key={s.key}
                  className="border-b border-border/40 last:border-0"
                >
                  <td className="py-1.5 pr-2 text-left">{s.label}</td>
                  <td
                    className={cn(
                      "px-2 py-1.5 text-right tabular-nums",
                      s.lifetimeTotalUsd > 0
                        ? lifetimeColor
                        : "text-muted-foreground",
                    )}
                  >
                    {formatCurrency(s.lifetimeTotalUsd)}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                    {s.lifetimeTotalUsd > 0 ? `${share.toFixed(0)}%` : "—"}
                  </td>
                  <td className="py-1.5 pl-2 text-right tabular-nums">
                    {s.lockedUsd > 0 ? (
                      <span className="text-rose-600 dark:text-rose-400">
                        {formatCurrency(s.lockedUsd)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t font-medium">
              <td className="py-1.5 pr-2 text-left">Total received</td>
              <td className="px-2 py-1.5 text-right tabular-nums">
                {formatCurrency(totalLifetime)}
              </td>
              <td className="px-2 py-1.5 text-right" />
              <td className="py-1.5 pl-2 text-right tabular-nums">
                {totalLockedUsd > 0 ? (
                  <span className="text-rose-600 dark:text-rose-400">
                    {formatCurrency(totalLockedUsd)}
                  </span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Honest framing of what "Lifetime" / "Locked" mean so an operator
          doesn't double-read the locked column as a separate liability. */}
      <p className="mt-3 border-t pt-2 text-[11px] leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground">Lifetime</span> is the
        total this user has received from each source (backend truth from the{" "}
        <code className="font-mono">balances</code> source columns).{" "}
        <span className="font-medium text-foreground">Locked</span> is the
        portion still gated behind the withdrawal wager requirement — a subset
        of the balance, not an extra amount. Deposits carry no per-source
        locked bucket.
      </p>
    </StatPanel>
  );
}

// ───────────────────────────────────────────────────────────────────
//  ACCOUNT TAB
// ───────────────────────────────────────────────────────────────────

export function AccountTab({
  data,
  notesPromise,
  pnlResultPromise,
  wagerRequirementPromise,
  wagerProgressPromise,
  balanceWeightingPromise,
}: {
  data: UserDetail;
  notesPromise: Promise<SafeQueryResult<AdminNote[]>> | null;
  pnlResultPromise: Promise<SafeQueryResult<PnlBreakdown>>;
  // Backend-API read (NOT the MAIN DB). Resolves to null when the backend
  // branch isn't deployed / the read failed — the card renders its muted
  // "awaiting backend deploy" state for null, exactly as before; only the
  // await point moved off the body gate's serial tail.
  wagerRequirementPromise: Promise<UserWagerRequirement | null> | null;
  // Read-only wager-requirement PROGRESS from the backend-written `balances`
  // columns (dev-only). null = prod / no-balance / read failed → muted card.
  wagerProgressPromise: Promise<UserWagerProgress | null> | null;
  // How each part of the balance is weighted toward each destination
  // (funding-source wager-weight matrix × balance composition). null = tab
  // not active / read failed → muted card.
  balanceWeightingPromise: Promise<UserBalanceWeighting | null> | null;
}) {
  const { user, balances, shippingAddress, vault, depositAddresses, featureLocks, battleLimits, mutes, capabilities } = data;
  return (
    <div className="space-y-6">
      <SectionHeading icon={Dices} title="Wagering Stats" />
      <WageringStatsCard balances={balances} />
      {/* Windowed P&L / Deposits / Wager strips — all three are fed by the
          same getUserPnlBreakdown call as the Overview tab's Rolling P&L
          ladder, so they stream as one cluster on pnlResultPromise (and the
          numbers can never drift between tabs). On failure: one VISIBLE
          band error, never five neutral $0.00 tiles. House POV per
          CLAUDE.md: positive P&L (user lost net) → emerald, negative (user
          gained net) → rose. */}
      <Suspense
        fallback={
          <>
            <SectionHeading icon={TrendingUp} title="Windowed P&L" />
            <SkeletonCard lines={3} />
          </>
        }
      >
        <WindowedStripsStreamed pnlResultPromise={pnlResultPromise} />
      </Suspense>
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
      <SectionHeading icon={Dices} title="Custom Battle Limits" />
      <UserBattleLimitsCard
        userId={user.id}
        limits={battleLimits}
        canManage={data.sessionRole === "admin"}
      />
      <SectionHeading icon={Banknote} title="Withdrawal Wager Requirement" />
      {wagerRequirementPromise ? (
        <Suspense fallback={<SkeletonCard lines={3} />}>
          <WagerRequirementStreamed
            userId={user.id}
            wagerRequirementPromise={wagerRequirementPromise}
            canManage={data.sessionRole === "admin"}
          />
        </Suspense>
      ) : (
        <SkeletonCard lines={3} />
      )}
      <SectionHeading icon={TrendingUp} title="Wager Requirement Progress" />
      {wagerProgressPromise ? (
        <Suspense fallback={<SkeletonCard lines={3} />}>
          <WagerProgressStreamed
            wagerProgressPromise={wagerProgressPromise}
            userId={user.id}
            canManage={data.sessionRole === "admin"}
          />
        </Suspense>
      ) : (
        <SkeletonCard lines={3} />
      )}
      <SectionHeading icon={Scale} title="Balance Wager Weighting" />
      {balanceWeightingPromise ? (
        <Suspense fallback={<SkeletonCard lines={4} />}>
          <BalanceWeightingStreamed
            balanceWeightingPromise={balanceWeightingPromise}
          />
        </Suspense>
      ) : (
        <SkeletonCard lines={4} />
      )}
      <SectionHeading icon={ShieldCheck} title="Moderation" />
      <Card>
        <CardContent className="pt-6 space-y-4">
          <ModerationSection user={user} mutes={mutes} />
        </CardContent>
      </Card>
      <SectionHeading icon={FileText} title="Admin Notes" />
      {notesPromise ? (
        <Suspense fallback={<SkeletonCard lines={3} />}>
          <NotesStreamed userId={user.id} notesPromise={notesPromise} />
        </Suspense>
      ) : (
        <SkeletonCard lines={3} />
      )}
    </div>
  );
}

// The three windowed strips (P&L / Deposits / Wager) share one P&L
// breakdown — `use()`d once here so a failed breakdown renders ONE visible
// band error instead of fifteen neutral "$0.00" tiles (a silent failure an
// admin would read as "quiet user").
function WindowedStripsStreamed({
  pnlResultPromise,
}: {
  pnlResultPromise: Promise<SafeQueryResult<PnlBreakdown>>;
}) {
  const r = use(pnlResultPromise);
  if (r.error) {
    return (
      <>
        <SectionHeading icon={TrendingUp} title="Windowed P&L" />
        <BandError
          title="Couldn't load windowed P&L / deposits / wager"
          hint="The P&L breakdown failed or timed out — this is a load failure, not a quiet account. Retry re-runs it."
        />
      </>
    );
  }
  const pnlBreakdown = r.data;
  return (
    <>
      <SectionHeading icon={TrendingUp} title="Windowed P&L" />
      <WindowedPnlStrip pnlBreakdown={pnlBreakdown} />
      <SectionHeading icon={Banknote} title="Windowed Deposits" />
      <WindowedDepositsStrip pnlBreakdown={pnlBreakdown} />
      <SectionHeading icon={Coins} title="Windowed Wager" />
      <WindowedWagerStrip pnlBreakdown={pnlBreakdown} />
    </>
  );
}

function WagerRequirementStreamed({
  userId,
  wagerRequirementPromise,
  canManage,
}: {
  userId: string;
  wagerRequirementPromise: Promise<UserWagerRequirement | null>;
  canManage: boolean;
}) {
  const wagerRequirement = use(wagerRequirementPromise);
  return (
    <UserWagerRequirementCard
      userId={userId}
      data={wagerRequirement}
      canManage={canManage}
    />
  );
}

function WagerProgressStreamed({
  wagerProgressPromise,
  userId,
  canManage,
}: {
  wagerProgressPromise: Promise<UserWagerProgress | null>;
  userId: string;
  canManage: boolean;
}) {
  const wagerProgress = use(wagerProgressPromise);
  return (
    <UserWagerProgressCard
      userId={userId}
      data={wagerProgress}
      canManage={canManage}
    />
  );
}

function BalanceWeightingStreamed({
  balanceWeightingPromise,
}: {
  balanceWeightingPromise: Promise<UserBalanceWeighting | null>;
}) {
  const weighting = use(balanceWeightingPromise);
  return <UserBalanceWeightingCard data={weighting} />;
}

function NotesStreamed({
  userId,
  notesPromise,
}: {
  userId: string;
  notesPromise: Promise<SafeQueryResult<AdminNote[]>>;
}) {
  const r = use(notesPromise);
  if (r.error) {
    return (
      <InlineError
        compact
        title="Couldn't load admin notes"
        hint="This is a load failure (admin DB), not an empty notes list — retry to re-run the query."
      />
    );
  }
  return <NotesSection userId={userId} notes={r.data} />;
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
        <CardContent className="p-0">
          <EmptyState
            icon={Dices}
            title="No wagering data yet"
            description="Wager totals appear once this user places their first bet."
            compact
          />
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
//  WINDOWED P&L STRIP — used by AccountTab below the wagering stats
// ───────────────────────────────────────────────────────────────────

/**
 * Five rolling P&L tiles (12h / 24h / 3d / 7d / 14d) shown as a
 * horizontal strip on the Account tab. Each tile shows the windowed
 * realized P&L for that user, computed by `getUserPnlBreakdown` via
 * the same `getUserWindowedPnlMulti` helper that powers the Rolling
 * P&L block on the Overview tab — the numbers are guaranteed to match
 * between tabs because both consume the same `pnlBreakdown` prop.
 *
 * House-POV color rule per CLAUDE.md:
 *   pnl > 0  → user lost net → house gain → emerald
 *   pnl < 0  → user gained net → house loss → rose
 *   pnl == 0 → neutral grey
 *
 * Tile sizing mirrors `ModernMetricTile` so the strip visually
 * matches the wagering-stats row directly above it. Grid wraps from
 * 2 columns on phones → 5 on lg so each window stays scannable
 * without horizontal scrolling on any breakpoint.
 */
function WindowedPnlStrip({
  pnlBreakdown,
}: {
  pnlBreakdown: PnlBreakdown;
}) {
  const windows: { label: string; pnl: number }[] = [
    { label: "Past 12h", pnl: pnlBreakdown.pnl12h },
    { label: "Past 24h", pnl: pnlBreakdown.pnl24h },
    { label: "Past 3d", pnl: pnlBreakdown.pnl3d },
    { label: "Past 7d", pnl: pnlBreakdown.pnl7d },
    { label: "Past 14d", pnl: pnlBreakdown.pnl14d },
  ];
  return (
    <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
      {windows.map((w) => {
        // Treat exact zero as neutral so a quiet user reads grey
        // instead of arbitrary emerald — same convention as the
        // dashboard's P&L tiles.
        const isZero = w.pnl === 0;
        const isHouseGain = w.pnl > 0;
        const accent: "emerald" | "rose" | "blue" = isZero
          ? "blue"
          : isHouseGain
            ? "emerald"
            : "rose";
        const Icon = isZero
          ? TrendingUp
          : isHouseGain
            ? TrendingUp
            : TrendingDown;
        const display = isZero
          ? formatCurrency(0)
          : `${isHouseGain ? "+" : ""}${formatCurrency(w.pnl)}`;
        return (
          <ModernMetricTile
            key={w.label}
            label={w.label}
            value={display}
            accent={accent}
            icon={Icon}
          />
        );
      })}
    </div>
  );
}

function WindowedDepositsStrip({
  pnlBreakdown,
}: {
  pnlBreakdown: PnlBreakdown;
}) {
  const windows: { label: string; amount: number }[] = [
    { label: "Past 24h", amount: pnlBreakdown.deposits24h },
    { label: "Past 3d", amount: pnlBreakdown.deposits3d },
    { label: "Past 7d", amount: pnlBreakdown.deposits7d },
    { label: "Past 14d", amount: pnlBreakdown.deposits14d },
  ];
  return (
    <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
      {windows.map((w) => (
        <ModernMetricTile
          key={w.label}
          label={w.label}
          value={formatCurrency(w.amount)}
          accent="emerald"
          icon={Banknote}
        />
      ))}
    </div>
  );
}

// Rolling wager tiles (24h / 3d / 7d / 14d) — total bet stakes in each
// window, mirroring the Windowed Deposits strip directly above. Amber to
// match the "Total Wagered" tile in the wagering-stats row.
function WindowedWagerStrip({
  pnlBreakdown,
}: {
  pnlBreakdown: PnlBreakdown;
}) {
  const windows: { label: string; amount: number }[] = [
    { label: "Past 24h", amount: pnlBreakdown.wager24h },
    { label: "Past 3d", amount: pnlBreakdown.wager3d },
    { label: "Past 7d", amount: pnlBreakdown.wager7d },
    { label: "Past 14d", amount: pnlBreakdown.wager14d },
  ];
  return (
    <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
      {windows.map((w) => (
        <ModernMetricTile
          key={w.label}
          label={w.label}
          value={formatCurrency(w.amount)}
          accent="amber"
          icon={Coins}
        />
      ))}
    </div>
  );
}
