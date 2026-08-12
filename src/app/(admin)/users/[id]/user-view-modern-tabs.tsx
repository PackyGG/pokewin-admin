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
import { useState, useEffect, useTransition, use, Suspense } from "react";
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
import {
  assignAffiliateCode,
  fetchUserAttributionJourney,
  transferAffiliateCode,
} from "./actions";
import type { AttributionJourneyEntry } from "@/lib/queries/users";
import { SetAffiliateCodeDialog } from "./user-tabs-creator";
import { StepUpField } from "@/components/step-up-field";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Wallet,
  TrendingUp,
  Swords,
  Gem,
  Trophy,
  Gift,
  Coins,
  ShieldCheck,
  ArrowDownToLine,
  ArrowUpFromLine,
  ArrowUpRight,
  ArrowLeftRight,
  Sparkles,
  Dices,
  Award,
  Flag,
  Waypoints,
  Loader2,
  Coins as CoinsIcon,
  BadgeCheck,
  Users,
  Fingerprint,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { CollapsibleSection } from "./collapsible-section";
import { EmptyState } from "@/components/empty-state";
import { InlineError } from "@/components/entity-surface/inline-error";
import { SkeletonCard, SkeletonTable } from "@/components/ux";
import { cn } from "@/lib/utils";
import { formatCurrency, formatDateTime, formatNumber } from "@/lib/utils/format";
import { RelativeTime } from "@/components/relative-time";
import { InfoRow } from "./user-tabs-shared";
import {
  type UserDetail,
  type PaginatedTransactions,
  type PnlBreakdown,
  CategoryTransactionsTable,
  AccountDetailsSection,
  DepositAddressesSection,
  FeatureLocksCard,
  DisposedCardsTable,
  InventoryGrid,
  GAMING_TX_TYPES,
  FINANCIAL_TX_TYPES,
  ADJUSTMENT_TX_TYPES,
  formatSignupProvider,
} from "./user-tabs";
import { UserBattleLimitsCard } from "./user-battle-limits-card";
import { UserVouchersPanel } from "./user-vouchers-panel";
import { JoinedBattlesPanel } from "./joined-battles-panel";
import type { UserFeatureLocks } from "@/lib/backend-api/feature-locks";
import { RewardFeatureLocksCard } from "./reward-feature-locks-card";
import type { FiatDepositAccess } from "@/lib/backend-api/fiat-deposit-access";
import type { FiatEligibilityOverride } from "@/lib/antifraud/fiat-eligibility-overrides-api";
import { FiatDepositAccessCard } from "./fiat-deposit-access-button";
import { KycCard } from "./kyc-card";
import type { UserKycStatus } from "@/lib/backend-api/kyc";
import { UserWagerProgressCard } from "./user-wager-progress-card";
import type { UserWagerProgress } from "@/lib/queries/users-wager-progress";
import { toWagerRequirementSummary } from "@/lib/queries/users-wager-progress-shared";
import type {
  PaginatedInventory,
  TipEntry,
  LeaderboardWinEntry,
  RaceClaimEntry,
} from "./user-tabs-types";
import {
  DEPOSIT_TX_TYPES,
  WITHDRAWAL_TX_TYPES,
} from "./user-tabs-types";
import { isMothaOnlyAdjustmentsProfile } from "@/lib/users/motha-only-adjustments-profile";
import type { UserRewards } from "@/lib/queries/users";
import type { SafeQueryResult } from "@/lib/errors/safe-query";
import type { UserRewardPackOpensResult } from "@/lib/queries/users-reward-pack-opens";
import { RewardPackOpensSection } from "./reward-pack-opens-section";
import { RewardsSummary } from "./rewards-summary-section";
import { BandError } from "./band-error";
import {
  SectionHeading,
  ModernBalancePanel,
  ModernPnlPanel,
  ModernActivityPanel,
  ModernMetricTile,
} from "./user-view-modern-panels";

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
  pnlResultPromise,
  wagerProgressPromise,
  isAdmin,
  viewerIsAdjustmentOwner,
  viewerCanSeeUltraLossback,
}: {
  data: UserDetail;
  financialTxPromise: Promise<SafeQueryResult<PaginatedTransactions>> | null;
  // Per-user wager-requirement progress (always kicked server-side). Threaded
  // into the Deposits & Withdrawals popup so the wager-requirement status
  // shows on a deposit/withdrawal row. null when not kicked → popup self-hides.
  wagerProgressPromise: Promise<UserWagerProgress | null> | null;
  // Platform-P&L breakdown — feeds the Balance panel's pnl7d (Lossback
  // autofill) + the Platform P&L panel with its rolling ladder. Always
  // kicked by the server (hero risk/pnl are tab-independent).
  pnlResultPromise: Promise<SafeQueryResult<PnlBreakdown>>;
  isAdmin: boolean;
  // Owner-only flag (motha). Hides the dedicated adjustments block + the
  // adjustment filter option for non-owners. The server already strips the
  // rows for non-owners; this is defence-in-depth UI hygiene only.
  viewerIsAdjustmentOwner: boolean;
  viewerCanSeeUltraLossback: boolean;
}) {
  const { user, statistics, counts, capabilities } = data;
  // Local open/close for the collapsible Deposits & Withdrawals section.
  // Default OPEN so first paint is unchanged; the streamed feed stays inside
  // the collapsible content (never a blocking await).
  const [dwOpen, setDwOpen] = useState(true);

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Modern stat panels — flat surface matching the hero: solid bg-card,
          hairline border, accent-tinted icon chip + hero number + breakdown
          rows below (no colored fill / corner glow). items-stretch (with
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

      {/* Deposits & Withdrawals — collapsible (default open). The Suspense +
          skeleton stay INSIDE the collapsible content so the section still
          shell-first streams (never a blocking await) and the balance panels
          above still paint first. */}
      <CollapsibleSection
        icon={ArrowDownToLine}
        title="Deposits & Withdrawals"
        open={dwOpen}
        onOpenChange={setDwOpen}
      >
        {financialTxPromise ? (
          <Suspense fallback={<SkeletonTable rows={5} columns={6} />}>
            <DepositsWithdrawalsStreamed
              userId={user.id}
              financialTxPromise={financialTxPromise}
              isAdmin={isAdmin}
              canEditBalanceAdjustments={capabilities.canEditBalanceAdjustments}
              viewerIsAdjustmentOwner={viewerIsAdjustmentOwner}
              viewerCanSeeUltraLossback={viewerCanSeeUltraLossback}
              wagerProgressPromise={wagerProgressPromise}
            />
          </Suspense>
        ) : (
          <SkeletonTable rows={5} columns={6} />
        )}
      </CollapsibleSection>

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
        canUseUltraLossback={capabilities.canUseUltraLossback}
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
  financialTxPromise,
  isAdmin,
  canEditBalanceAdjustments,
  viewerIsAdjustmentOwner,
  viewerCanSeeUltraLossback,
  wagerProgressPromise,
}: {
  userId: string;
  financialTxPromise: Promise<SafeQueryResult<PaginatedTransactions>>;
  isAdmin: boolean;
  canEditBalanceAdjustments: boolean;
  viewerIsAdjustmentOwner: boolean;
  viewerCanSeeUltraLossback: boolean;
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
  const financialTypes = viewerIsAdjustmentOwner || viewerCanSeeUltraLossback
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
  open,
  onOpenChange,
}: {
  userId: string;
  adjustmentsTxPromise: Promise<SafeQueryResult<PaginatedTransactions>>;
  isAdmin: boolean;
  canEditBalanceAdjustments: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const r = use(adjustmentsTxPromise);
  // Load failure → a VISIBLE compact error card. The owner must be able to
  // tell "no adjustments exist" (genuine empty → block self-hides below)
  // from "the adjustments query failed" — silently self-hiding on failure
  // would hide real adjustments behind a transient error. The collapsible
  // lives INSIDE this component (not wrapped around it in AccountTab) so the
  // whole section still self-hides when the user has zero adjustments.
  if (r.error) {
    return (
      <CollapsibleSection
        icon={Coins}
        title="Admin balance adjustments"
        open={open}
        onOpenChange={onOpenChange}
      >
        <InlineError
          compact
          title="Couldn't load admin balance adjustments"
          hint="This is a load failure, not an empty history — retry to re-run the query."
        />
      </CollapsibleSection>
    );
  }
  const adjustmentsTx = r.data;
  if (adjustmentsTx.total <= 0) return null;
  const mothaOnly = isMothaOnlyAdjustmentsProfile(userId);
  return (
    <CollapsibleSection
      icon={Coins}
      title="Admin balance adjustments"
      open={open}
      onOpenChange={onOpenChange}
    >
      {mothaOnly ? (
        <p className="mb-2 text-xs text-muted-foreground">
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
    </CollapsibleSection>
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
                            href="/rewards?tab=leaderboards"
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
  tips,
}: {
  rewardsPromise: Promise<SafeQueryResult<UserRewards>> | null;
  // Reward / sign-up pack opens (welcome/level/daily packs) + the cards they
  // granted. null = not kicked for the active tab (Active-Timeframe-Only).
  rewardPackOpensPromise: Promise<
    SafeQueryResult<UserRewardPackOpensResult>
  > | null;
  // Rain / race / leaderboard / creator-tip aggregates — already part of the
  // main user-detail aggregate (no extra query), surfaced here as reward stat
  // boxes alongside rakeback. Also shown on Overview (Tips & Rain); the owner
  // wants a consolidated Rewards summary too.
  tips: UserDetail["tips"];
}) {
  return (
    <div className="space-y-6">
      {rewardsPromise ? (
        <Suspense fallback={<RewardsSummarySkeleton />}>
          <RewardsStreamed rewardsPromise={rewardsPromise} tips={tips} />
        </Suspense>
      ) : (
        <RewardsSummarySkeleton />
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

function RewardsSummarySkeleton() {
  return (
    <div className="space-y-3">
      <SectionHeading icon={Gift} title="Rewards summary" />
      <SkeletonCard lines={5} />
    </div>
  );
}

function RewardsStreamed({
  rewardsPromise,
  tips,
}: {
  rewardsPromise: Promise<SafeQueryResult<UserRewards>>;
  tips: UserDetail["tips"];
}) {
  const r = use(rewardsPromise);
  if (r.error) {
    return (
      <div className="space-y-3">
        <SectionHeading icon={Gift} title="Rewards summary" />
        <InlineError
          compact
          title="Couldn't load rewards"
          hint="This is a load failure, not an empty rewards history — retry to re-run the query."
        />
      </div>
    );
  }
  return <RewardsSummary rewards={r.data} tips={tips} />;
}

// ───────────────────────────────────────────────────────────────────
//  GAMING TAB
// ───────────────────────────────────────────────────────────────────

export function GamingTab({
  data,
  gamingTxPromise,
}: {
  data: UserDetail;
  gamingTxPromise: Promise<SafeQueryResult<PaginatedTransactions>> | null;
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

      {/* Sponsored / free battles the user joined with no ledger row — moved
          here from the Overview tab. These never appear in the ledger-backed
          gaming history above (that reads only ledger_transactions), so they
          belong on the Gaming tab. Self-fetching (kicks only when this tab
          mounts) + hidden when none. */}
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
}: {
  data: UserDetail;
  // Both inventory pages are tab-gated reads (kicked only when ?tab=
  // inventory is active — Active-Timeframe-Only). The hero's inventory /
  // voucher VALUES come from `balances` inside the detail aggregate, so
  // moving the owned page out of the body gate costs the hero nothing.
  inventoryPromise: Promise<SafeQueryResult<PaginatedInventory>> | null;
  disposedInventoryPromise: Promise<SafeQueryResult<PaginatedInventory>> | null;
}) {
  const { user } = data;
  // Sold & Exchanged is collapsed by default so the Inventory tab opens clean.
  // `disposedOpenToken` bumps on every OPEN so the (self-stateful) disposed
  // table remounts fresh — i.e. it always re-opens on page 1.
  const [disposedOpen, setDisposedOpen] = useState(false);
  const [disposedOpenToken, setDisposedOpenToken] = useState(0);
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

      {/* Sold & Exchanged — collapsible, collapsed by default so the tab opens
          clean. The existing DisposedCardsTable keeps its own status tabs /
          search / filters / server pagination; keying the Suspense on
          `disposedOpenToken` remounts it on each open so it always re-opens on
          page 1. The disposed read is still the same tab-gated promise from
          page.tsx (fetch unchanged). */}
      <CollapsibleSection
        icon={Trophy}
        title="Sold & Exchanged"
        open={disposedOpen}
        onOpenChange={(next) => {
          setDisposedOpen(next);
          if (next) setDisposedOpenToken((t) => t + 1);
        }}
      >
        {disposedInventoryPromise ? (
          <Suspense
            key={disposedOpenToken}
            fallback={<SkeletonTable rows={5} columns={5} />}
          >
            <DisposedCardsStreamed
              userId={user.id}
              disposedInventoryPromise={disposedInventoryPromise}
            />
          </Suspense>
        ) : (
          <SkeletonTable rows={5} columns={5} />
        )}
      </CollapsibleSection>
    </div>
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
//  AFFILIATE SECTION — folded into the Account tab (was its own tab)
// ───────────────────────────────────────────────────────────────────

// Renders the full affiliate surface (referrer, attribution journey, owned
// codes, affiliate stats). Previously the standalone "Affiliate" tab; now
// rendered as a section INSIDE the Account tab so all account-level admin
// surfaces live on one tab. Body unchanged — only the mounting point moved.
function AffiliateSection({ data }: { data: UserDetail }) {
  const { user, affiliate } = data;
  // Each distinct sub-part below was already separately headed (own
  // SectionHeading) before this pass — collapsing them individually reads
  // better than one giant Affiliate block, and matches the granularity of
  // every other section on this tab. All default COLLAPSED (owner request —
  // same as the rest of the Account tab, which now opens with every section
  // collapsed beneath the pinned, non-collapsible Account Details block).
  const [referrerOpen, setReferrerOpen] = useState(false);
  const [attributionOpen, setAttributionOpen] = useState(false);
  const [ownCodeOpen, setOwnCodeOpen] = useState(false);
  const [affiliateStatsOpen, setAffiliateStatsOpen] = useState(false);
  return (
    <div className="space-y-4">
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
      <CollapsibleSection
        icon={ArrowDownToLine}
        title="Joined Under (Referrer)"
        open={referrerOpen}
        onOpenChange={setReferrerOpen}
      >
        <ReferrerCard user={user} />
      </CollapsibleSection>

      {/* Attribution journey — the codes this user hopped through over
          time + the economics booked under each. Lazy-loaded on mount so
          it never burdens the always-rendered page payload. Sits right
          under the referrer card because it's the same side of the
          relationship: how THIS user was attributed to creators (not the
          codes they own, which the next section covers). */}
      <CollapsibleSection
        icon={Waypoints}
        title="Attribution Journey"
        open={attributionOpen}
        onOpenChange={setAttributionOpen}
      >
        <AttributionJourneySection userId={user.id} />
      </CollapsibleSection>

      <CollapsibleSection
        icon={Sparkles}
        title="Their Own Affiliate Code"
        open={ownCodeOpen}
        onOpenChange={setOwnCodeOpen}
      >
        <OwnCodeCard user={user} affiliate={affiliate} />
      </CollapsibleSection>

      {/* Section 3: Stats — only render if the affiliate_accounts row exists */}
      {affiliate && (
        <CollapsibleSection
          icon={TrendingUp}
          title="Affiliate Stats"
          open={affiliateStatsOpen}
          onOpenChange={setAffiliateStatsOpen}
        >
          <div className="grid gap-3 grid-cols-2 lg:grid-cols-3">
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
        </CollapsibleSection>
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
        <CardContent className="flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading attribution journey…
        </CardContent>
      </Card>
    );
  }

  if (state.status === "error") {
    return (
      <Card>
        <CardContent className="p-4">
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
    <div className="space-y-3">
      {/* Headline strip — distinct-codes count + lifetime deposits/wager
          booked across the whole journey. */}
      <div className="grid gap-3 grid-cols-1 sm:grid-cols-3">
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
                  className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4"
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
    // Flat: plain neutral Card. The decorative blue left-border tint was
    // dropped in the cleaner/flatter pass — this card is distinguished from
    // the "Own Affiliate Code" card below by its section heading + content,
    // not a color accent.
    <Card>
      <CardContent className="space-y-3">
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
                    className="rounded-md border bg-muted px-2 py-1 font-mono text-sm font-semibold text-foreground transition-colors hover:bg-muted/70"
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
                <span className="rounded-md border bg-muted px-2 py-1 font-mono text-sm font-semibold text-foreground">
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
    // Flat: plain neutral Card. The decorative purple left-border tint was
    // dropped in the cleaner/flatter pass — still distinct from the Referrer
    // card above via its section heading + content, not a color accent.
    <Card>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground">
              Codes they own ({owned.length})
            </p>
            {/* Only worth its own link once there's more than one code —
                with a single owned code this would be identical to that
                code's own "View referrals" link in OwnedCodeRow below. */}
            {owned.length > 1 && (
              <Button
                size="xs"
                variant="ghost"
                className="text-muted-foreground"
                nativeButton={false}
                render={
                  <Link href={`/users?affiliateOwnerId=${encodeURIComponent(user.id)}`} />
                }
              >
                <Users className="size-3" />
                View all referrals
              </Button>
            )}
          </div>
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
                referralCount={c.referralCount}
                userRole={user.role}
                userId={user.id}
                ownerLabel={user.username ?? user.email ?? user.id.slice(0, 8)}
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
          on /creators/[id]; use a row&apos;s &quot;Transfer&quot; button to
          move it to another account. To remove a code, use the /creators
          dashboard.
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

// One row in the owned-codes list. The code chip links to the code
// owner's own stat page (or, for users with role=creator, the creator
// dashboard which has the full deep-dive); "View referrals" is a
// separate, additional control that jumps to the existing /users list
// pre-filtered to the users THIS code referred (?affiliateCode=, see
// buildUserListWhereClause in src/lib/queries/users-list.ts — mirrors
// the same affiliate_code_usages join getCodeReferrals/getCodeAnalytics
// in src/lib/queries/creators-codes.ts already use for "who did this
// code refer"). Two sibling links, not one wrapping link, so neither
// nests inside the other.
function OwnedCodeRow({
  code,
  createdAt,
  referralCount,
  userRole,
  userId,
  ownerLabel,
}: {
  code: string;
  createdAt: string;
  referralCount: number;
  userRole: string;
  userId: string;
  /** Current owner's display label (username/email/id-prefix), shown in the transfer dialog. */
  ownerLabel: string;
}) {
  const [transferOpen, setTransferOpen] = useState(false);
  const codeHref =
    userRole === "creator"
      ? `/creators/${userId}`
      : `/users/${userId}`;
  return (
    <div className="group flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 transition-colors hover:border-border hover:bg-muted/40">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={codeHref}
          className="inline-flex items-center gap-1 rounded-md border bg-muted px-2 py-1 font-mono text-sm font-semibold text-foreground transition-colors hover:bg-muted/70"
        >
          {code}
          <ArrowUpRight className="size-3 opacity-50 transition-opacity group-hover:opacity-100" />
        </Link>
        <span className="text-[11px] text-muted-foreground">
          {referralCount} {referralCount === 1 ? "referral" : "referrals"}
        </span>
        <Button
          size="xs"
          variant="ghost"
          className="text-muted-foreground"
          nativeButton={false}
          render={
            <Link href={`/users?affiliateCode=${encodeURIComponent(code)}`} />
          }
        >
          <Users className="size-3" />
          View referrals
        </Button>
        <Button
          size="xs"
          variant="ghost"
          className="text-muted-foreground"
          onClick={() => setTransferOpen(true)}
        >
          <ArrowLeftRight className="size-3" />
          Transfer
        </Button>
      </div>
      <span className="text-[11px] text-muted-foreground">
        added <RelativeTime date={createdAt} />
      </span>
      <TransferCodeDialog
        open={transferOpen}
        onOpenChange={setTransferOpen}
        code={code}
        fromLabel={ownerLabel}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
//  Transfer Code Dialog — moves an owned affiliate code to another
//  account. Defaults the target to "motha" (the super-owner's own game
//  account, username "motha" per MAIN_OWNER_USERNAME in @/lib/owners —
//  hardcoded here rather than imported since that module also pulls in
//  server-only deps not safe to bundle client-side), editable to any
//  other username or user id. Same 2FA-gated transferAffiliateCode
//  action SetAffiliateCodeDialog's conflict flow uses — the previous
//  owner gets a random replacement code so they're never codeless.
// ─────────────────────────────────────────────────────────────────────

const DEFAULT_TRANSFER_TARGET = "motha";

function TransferCodeDialog({
  open,
  onOpenChange,
  code,
  fromLabel,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  code: string;
  fromLabel: string;
}) {
  const router = useRouter();
  const [targetInput, setTargetInput] = useState(DEFAULT_TRANSFER_TARGET);
  const [totpCode, setTotpCode] = useState("");
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (open) {
      setTargetInput(DEFAULT_TRANSFER_TARGET);
      setTotpCode("");
    }
  }, [open]);

  function close() {
    onOpenChange(false);
  }

  function handleSubmit() {
    const target = targetInput.trim();
    if (!target) {
      toast.error("Enter a target username or user id");
      return;
    }
    if (!totpCode.trim()) {
      toast.error("Please enter your 2FA code");
      return;
    }
    startTransition(async () => {
      const result = await transferAffiliateCode({
        toUserId: target,
        code,
        totpCode: totpCode.trim(),
      });
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success(
        `Transferred "${code}" from @${fromLabel} → ${target}. Their replacement code: ${result.replacementCode}`,
        { duration: 8000 },
      );
      close();
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Transfer affiliate code</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <p className="text-xs text-muted-foreground">
            Moves{" "}
            <span className="font-mono font-medium text-foreground">
              {code}
            </span>{" "}
            from{" "}
            <span className="font-medium text-foreground">@{fromLabel}</span>{" "}
            to another account. The current owner gets a random
            replacement code so they&apos;re never codeless — their
            historical referrals + earnings stay attributed to them.
          </p>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              Target username or user ID
            </Label>
            <Input
              value={targetInput}
              onChange={(e) => setTargetInput(e.target.value)}
              placeholder="e.g. motha"
              disabled={isPending}
              autoFocus
            />
            <p className="text-[11px] text-muted-foreground">
              Defaults to &quot;motha&quot; (the super-owner account) —
              overwrite to transfer somewhere else instead.
            </p>
          </div>
          {/* 2FA gate — same shape as SetAffiliateCodeDialog's transfer flow. */}
          <StepUpField
            value={totpCode}
            onChange={setTotpCode}
            disabled={isPending}
          />
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={close}
            disabled={isPending}
            className="w-full sm:w-auto"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isPending || !targetInput.trim() || !totpCode.trim()}
            className="w-full sm:w-auto bg-amber-600 hover:bg-amber-600/90 text-white"
          >
            {isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              "Transfer"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ───────────────────────────────────────────────────────────────────
//  ACCOUNT TAB
// ───────────────────────────────────────────────────────────────────

function AccountStatBox({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "neutral" | "emerald" | "rose" | "amber";
}) {
  return (
    <div className="min-w-0 rounded-lg border bg-muted/15 px-3 py-2">
      <p className="truncate text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p
        className={cn(
          "mt-0.5 truncate text-sm font-bold tabular-nums",
          tone === "emerald" && "text-emerald-600 dark:text-emerald-400",
          tone === "rose" && "text-rose-600 dark:text-rose-400",
          tone === "amber" && "text-amber-600 dark:text-amber-400",
        )}
        title={value}
      >
        {value}
      </p>
    </div>
  );
}

function AccountStatColumn({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <p className="mb-2 truncate border-b pb-1.5 text-[11px] font-bold uppercase tracking-wider text-foreground">
        {label}
      </p>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function AccountStatsStreamed({
  balances,
  pnlResultPromise,
}: {
  balances: UserDetail["balances"];
  pnlResultPromise: Promise<SafeQueryResult<PnlBreakdown>>;
}) {
  const result = use(pnlResultPromise);
  const platformPnl = balances
    ? balances.totalDeposited -
      balances.totalWithdrawn -
      balances.availableBalance -
      balances.lockedBalance -
      balances.inventoryValue -
      balances.vouchersValue
    : 0;

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <AccountStatColumn label="Lifetime">
        <AccountStatBox label="Total Deposited" value={balances ? formatCurrency(balances.totalDeposited) : "—"} tone="emerald" />
        <AccountStatBox label="Total Wagered" value={balances ? formatCurrency(balances.totalWagered) : "—"} tone="amber" />
        <AccountStatBox label="P&L" value={balances ? `${platformPnl > 0 ? "+" : ""}${formatCurrency(platformPnl)}` : "—"} tone={platformPnl > 0 ? "emerald" : platformPnl < 0 ? "rose" : "neutral"} />
      </AccountStatColumn>

      {result.error ? (
        <div className="col-span-1 lg:col-span-3">
          <BandError title="Couldn't load windowed stats" hint="The P&L breakdown failed or timed out." />
        </div>
      ) : (
        <>
          <AccountStatColumn label="Window P&L">
            {([
              ["24h", result.data.pnl24h],
              ["7d", result.data.pnl7d],
              ["1m", result.data.pnl30d],
            ] as const).map(([period, amount]) => (
              <AccountStatBox key={period} label={period} value={`${amount > 0 ? "+" : ""}${formatCurrency(amount)}`} tone={amount > 0 ? "emerald" : amount < 0 ? "rose" : "neutral"} />
            ))}
          </AccountStatColumn>
          <AccountStatColumn label="Deposits">
            {([
              ["24h", result.data.deposits24h],
              ["7d", result.data.deposits7d],
              ["1m", result.data.deposits30d],
            ] as const).map(([period, amount]) => (
              <AccountStatBox key={period} label={period} value={formatCurrency(amount)} tone="emerald" />
            ))}
          </AccountStatColumn>
          <AccountStatColumn label="Wager">
            {([
              ["24h", result.data.wager24h],
              ["7d", result.data.wager7d],
              ["1m", result.data.wager30d],
            ] as const).map(([period, amount]) => (
              <AccountStatBox key={period} label={period} value={formatCurrency(amount)} tone="amber" />
            ))}
          </AccountStatColumn>
        </>
      )}
    </div>
  );
}

export function AccountTab({
  data,
  pnlResultPromise,
  featureLocksPromise,
  fiatDepositAccessPromise,
  preFiatOverridePromise,
  wagerProgressPromise,
  adjustmentsTxPromise,
  viewerIsAdjustmentOwner,
  viewerCanSeeUltraLossback,
}: {
  data: UserDetail;
  pnlResultPromise: Promise<SafeQueryResult<PnlBreakdown>>;
  // Backend-API read (NOT the MAIN DB). Resolves to null when the backend
  // branch isn't deployed / the read failed — the card renders its muted
  // "awaiting backend deploy" state for null, exactly as before; only the
  // await point moved off the body gate's serial tail.
  // Backend-API read of the fraud-signal deposit/withdrawal locks (card
  // refund/chargeback). Same catch→null convention as the wager-requirement
  // override above.
  featureLocksPromise: Promise<UserFeatureLocks | null> | null;
  // Backend-API read of the per-user Fiat deposit allow-list. This does not
  // represent or override fraud/compliance/KYC/location locks.
  fiatDepositAccessPromise: Promise<FiatDepositAccess | null> | null;
  preFiatOverridePromise: Promise<FiatEligibilityOverride | null> | null;
  // Read-only wager-requirement PROGRESS from the backend-written `balances`
  // columns (dev-only). null = prod / no-balance / read failed → muted card.
  wagerProgressPromise: Promise<UserWagerProgress | null> | null;
  // How each part of the balance is weighted toward each destination
  // (funding-source wager-weight matrix × balance composition). null = tab
  // not active / read failed → muted card.
  // Owner-only (motha) dedicated uncapped admin_balance_adjustment page —
  // moved here from the Overview tab. Streamed + lazy: page.tsx kicks
  // adjustmentsTxPromise only when the Account tab is active
  // (Active-Timeframe-Only). null for a non-owner viewer / non-active tab.
  adjustmentsTxPromise: Promise<SafeQueryResult<PaginatedTransactions>> | null;
  // Owner-only flag (motha). Gates the adjustments block below so a non-owner
  // never sees it (defence-in-depth; the server already returns zero rows).
  viewerIsAdjustmentOwner: boolean;
  viewerCanSeeUltraLossback: boolean;
}) {
  const { user, balances, shippingAddress, vault, depositAddresses, featureLocks, battleLimits, capabilities } = data;
  // Local open/close state for each collapsible Account-tab section. Every
  // section now defaults to COLLAPSED (owner request) so the tab opens
  // compact — only the non-collapsible "Account Details" block pinned at the
  // top is always shown; the admin expands the rest as needed. Same
  // controlled pattern as the Deposits & Withdrawals collapsible on the
  // Overview tab (CollapsibleSection).
  const [adminAdjustmentsOpen, setAdminAdjustmentsOpen] = useState(false);
  const [featureAccessOpen, setFeatureAccessOpen] = useState(false);
  const [battleLimitsOpen, setBattleLimitsOpen] = useState(false);
  const [wagerProgressOpen, setWagerProgressOpen] = useState(false);
  return (
    <div className="space-y-4">
      {/* Account Details — pinned at the top and not collapsible. Deposit
          addresses live at the bottom of the tab so wallet identifiers never
          crowd the primary identity, shipping, and vault facts. */}
      <SectionHeading icon={ShieldCheck} title="Account Details" />
      <Card>
        <CardContent>
          <div className="grid items-start gap-6 lg:grid-cols-3">
            <AccountDetailsSection
              user={user}
              shippingAddress={shippingAddress}
              canEditIdentity={capabilities.canEditIdentity}
            />
            <div className="min-w-0 lg:col-span-2 lg:border-l lg:pl-6">
              <Suspense fallback={<SkeletonCard lines={5} />}>
                <AccountStatsStreamed
                  balances={balances}
                  pnlResultPromise={pnlResultPromise}
                />
              </Suspense>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Admin balance adjustments — OWNER ONLY (motha). Moved here from the
          Overview tab. Non-owner admins never see this block: the server
          returns zero adjustment rows for them (so it would self-hide anyway),
          but we also gate the render here so the heading can't flash. Streamed
          + lazy — adjustmentsTxPromise is kicked only when the Account tab is
          active (Active-Timeframe-Only). Admin inventory removals/sales are
          written as admin_balance_adjustment rows ("Inventory removed: …"), so
          they surface here + in the Deposits & Withdrawals box on Overview —
          like any other balance adjustment. */}
      {(viewerIsAdjustmentOwner || viewerCanSeeUltraLossback) &&
        adjustmentsTxPromise && (
        <Suspense fallback={null}>
          <AdminAdjustmentsStreamed
            userId={user.id}
            adjustmentsTxPromise={adjustmentsTxPromise}
            isAdmin={data.sessionRole === "admin"}
            canEditBalanceAdjustments={capabilities.canEditBalanceAdjustments}
            open={adminAdjustmentsOpen}
            onOpenChange={setAdminAdjustmentsOpen}
          />
        </Suspense>
        )}

      <CollapsibleSection
        icon={ShieldCheck}
        title="Feature Locks & Fiat Access"
        open={featureAccessOpen}
        onOpenChange={setFeatureAccessOpen}
      >
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <div className="space-y-4">
            <FeatureLocksCard
              userId={user.id}
              featureLocks={featureLocks}
              canToggle={capabilities.canToggleFeatureLocks}
            />
            {fiatDepositAccessPromise && preFiatOverridePromise ? (
              <Suspense fallback={<SkeletonCard lines={3} />}>
                <FiatDepositAccessStreamed
                  userId={user.id}
                  fiatDepositAccessPromise={fiatDepositAccessPromise}
                  preFiatOverridePromise={preFiatOverridePromise}
                  canManage={data.sessionRole === "admin"}
                />
              </Suspense>
            ) : (
              <SkeletonCard lines={3} />
            )}
          </div>
          {featureLocksPromise ? (
            <Suspense fallback={<SkeletonCard lines={6} />}>
              <RewardFeatureLocksStreamed
                userId={user.id}
                featureLocksPromise={featureLocksPromise}
                canManageRewardLocks={capabilities.canToggleFeatureLocks}
                canManageFiatAutoApproval={data.sessionRole === "admin"}
              />
            </Suspense>
          ) : (
            <SkeletonCard lines={6} />
          )}
        </div>
      </CollapsibleSection>

      <CollapsibleSection
        icon={Dices}
        title="Custom Battle Limits"
        open={battleLimitsOpen}
        onOpenChange={setBattleLimitsOpen}
      >
        <UserBattleLimitsCard
          userId={user.id}
          limits={battleLimits}
          canManage={data.sessionRole === "admin"}
        />
      </CollapsibleSection>

      <CollapsibleSection
        icon={TrendingUp}
        title="Wager Requirement Progress"
        open={wagerProgressOpen}
        onOpenChange={setWagerProgressOpen}
      >
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
      </CollapsibleSection>

      {/* Affiliate — folded in from the old standalone Affiliate tab.
          AffiliateSection renders the referrer card, attribution journey,
          owned codes and affiliate stats (all reading data.affiliate /
          data.user), so admins still manage a user's referral code from
          here. The lead heading marks the start of the affiliate block; the
          section itself wraps each distinct sub-part (creator dashboard,
          referrer, attribution journey, own code, stats) in its own
          CollapsibleSection below. */}
      <SectionHeading icon={Sparkles} title="Affiliate" />
      <AffiliateSection data={data} />

      {/* Operational wallet identifiers are useful, but not primary account
          facts. Keep them at the end so long address lists cannot push the
          controls an admin came here to use down the page. */}
      {(vault || depositAddresses.length > 0) && (
        <>
          <SectionHeading icon={Wallet} title="Vault & Deposit Addresses" />
          <Card>
            <CardContent>
              <DepositAddressesSection
                vault={vault}
                depositAddresses={depositAddresses}
              />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────
//  KYC TAB — Sumsub identity verification status + admin controls.
//  Split out of the Account tab into its own tab (owner request) so the
//  verification state + Require/Review actions get a dedicated surface
//  instead of being one collapsible among the account-management stack.
//  The read is the same backend-owned catch→null promise, now kicked by
//  page.tsx only when ?tab=kyc is active (Active-Timeframe-Only) — so the
//  `null` prop still renders the card's muted "awaiting backend deploy"
//  skeleton exactly as it did inside the Account tab.
// ───────────────────────────────────────────────────────────────────
export function KycTab({
  data,
  kycPromise,
  canManage,
}: {
  data: UserDetail;
  kycPromise: Promise<UserKycStatus | null> | null;
  canManage: boolean;
}) {
  const { user, balances } = data;
  return (
    <div className="space-y-6">
      {/* Decision basics FIRST — the signals an admin scans to decide whether
          to require identity verification: who they are, where they signed up
          from (IP / geo), and how much money is in play. All read from the
          already-loaded user detail — no extra query, no streaming. */}
      <SectionHeading icon={Fingerprint} title="KYC Decision Info" />
      <KycDecisionInfo user={user} balances={balances} />

      <SectionHeading icon={BadgeCheck} title="KYC (Sumsub)" />
      {kycPromise ? (
        <Suspense fallback={<SkeletonCard lines={3} />}>
          <KycStreamed
            userId={user.id}
            accountCountry={user.countryCode}
            kycPromise={kycPromise}
            canManage={canManage}
          />
        </Suspense>
      ) : (
        <SkeletonCard lines={3} />
      )}
    </div>
  );
}

// Compact, read-only "should we KYC this person?" panel. Three plain columns
// of InfoRows (same primitive + column-group styling as AccountDetailsSection)
// — Identity, Location & IP, Financial exposure. Everything comes from the
// already-fetched UserDetail, so it paints instantly with the tab. `balances`
// can be null (schema drift / no balance row) → the money rows show $0.00.
function KycDecisionInfo({
  user,
  balances,
}: {
  user: UserDetail["user"];
  balances: UserDetail["balances"];
}) {
  return (
    <Card>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {/* Identity */}
          <div className="min-w-0">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Identity
            </p>
            <div className="space-y-2">
              <InfoRow label="Email" value={user.email ?? "—"} truncate />
              <InfoRow
                label="Email verified"
                value={user.emailVerified ? "Yes" : "No"}
              />
              <InfoRow
                label="Signed up with"
                value={formatSignupProvider(user.signupProvider)}
              />
              <InfoRow
                label="2FA"
                value={user.twoFactorEnabled ? "On" : "Off"}
              />
              <InfoRow
                label="Registered"
                value={
                  <>
                    {formatDateTime(user.createdAt)}{" "}
                    <span className="text-muted-foreground/70">
                      (<RelativeTime date={user.createdAt} />)
                    </span>
                  </>
                }
              />
            </div>
          </div>

          {/* Location & IP */}
          <div className="min-w-0">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Location &amp; IP
            </p>
            <div className="space-y-2">
              <InfoRow
                label="Signup IP"
                value={user.signupIp ?? "—"}
                mono
                truncate
              />
              <InfoRow
                label="Country"
                value={
                  [user.country, user.countryCode]
                    .filter(Boolean)
                    .join(" · ") || "—"
                }
              />
              <InfoRow
                label="City / State"
                value={
                  [user.city, user.state].filter(Boolean).join(", ") || "—"
                }
              />
              <InfoRow label="Continent" value={user.continentCode || "—"} />
            </div>
          </div>

          {/* Financial exposure */}
          <div className="min-w-0">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Financial
            </p>
            <div className="space-y-2">
              <InfoRow
                label="Deposited"
                value={
                  <>
                    {formatCurrency(balances?.totalDeposited ?? 0)}
                    {(balances?.fiatDeposits ?? 0) > 0 ? (
                      <span className="text-muted-foreground/70">
                        {" "}
                        · {formatCurrency(balances?.fiatDeposits ?? 0)} fiat
                      </span>
                    ) : null}
                  </>
                }
              />
              <InfoRow
                label="Withdrawn"
                value={formatCurrency(balances?.totalWithdrawn ?? 0)}
              />
              <InfoRow
                label="Wagered"
                value={formatCurrency(balances?.totalWagered ?? 0)}
              />
              <InfoRow
                label="Balance"
                value={formatCurrency(balances?.availableBalance ?? 0)}
              />
              <InfoRow
                label="Inventory"
                value={formatCurrency(balances?.inventoryValue ?? 0)}
              />
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function RewardFeatureLocksStreamed({
  userId,
  featureLocksPromise,
  canManageRewardLocks,
  canManageFiatAutoApproval,
}: {
  userId: string;
  featureLocksPromise: Promise<UserFeatureLocks | null>;
  canManageRewardLocks: boolean;
  canManageFiatAutoApproval: boolean;
}) {
  const featureLocks = use(featureLocksPromise);
  return (
    <RewardFeatureLocksCard
      userId={userId}
      data={featureLocks}
      canManageRewardLocks={canManageRewardLocks}
      canManageFiatAutoApproval={canManageFiatAutoApproval}
    />
  );
}

function FiatDepositAccessStreamed({
  userId,
  fiatDepositAccessPromise,
  preFiatOverridePromise,
  canManage,
}: {
  userId: string;
  fiatDepositAccessPromise: Promise<FiatDepositAccess | null>;
  preFiatOverridePromise: Promise<FiatEligibilityOverride | null>;
  canManage: boolean;
}) {
  const access = use(fiatDepositAccessPromise);
  const preFiatOverride = use(preFiatOverridePromise);
  return (
    <FiatDepositAccessCard
      userId={userId}
      data={access}
      preFiatOverride={preFiatOverride}
      canManage={canManage}
    />
  );
}

function KycStreamed({
  userId,
  accountCountry,
  kycPromise,
  canManage,
}: {
  userId: string;
  accountCountry: string | null;
  kycPromise: Promise<UserKycStatus | null>;
  canManage: boolean;
}) {
  const kyc = use(kycPromise);
  return (
    <KycCard
      userId={userId}
      accountCountry={accountCountry}
      data={kyc}
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
