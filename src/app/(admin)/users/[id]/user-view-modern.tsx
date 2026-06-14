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
import {
  useCallback,
  useMemo,
  useState,
  useEffect,
  useTransition,
  use,
  Suspense,
} from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Wallet,
  TrendingUp,
  TrendingDown,
  Swords,
  Gem,
  Gift,
  Coins,
  ShieldCheck,
  ShieldAlert,
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  ArrowUpCircle,
  Hourglass,
  Banknote,
  Sparkles,
  Percent,
  Calendar,
  MapPin,
  Link2,
  Megaphone,
  GitBranch,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils/format";
import { RelativeTime } from "@/components/relative-time";
import { ROLE_COLORS, USER_STATUS_COLORS } from "@/lib/constants";
import {
  type UserDetail,
  type PaginatedTransactions,
  type PnlBreakdown,
  type AdminNote,
} from "./user-tabs";
import type { UserRewards } from "@/lib/queries/users";
import type { PaginatedInventory } from "./user-tabs-types";
import type { SharedIdentityUser } from "@/lib/fraud/shared-identity-types";
import type { UserWagerRequirement } from "@/lib/backend-api/wager-requirements";
import type { UserWagerProgress } from "@/lib/queries/users-wager-progress";
import type {
  ShardWinningsResult,
  ShardPackOpensResult,
} from "@/lib/queries/users-shard-winnings";
import type { UserXpPurchasesResult } from "@/lib/queries/users-xp-purchases";
import type { UserRewardPackOpensResult } from "@/lib/queries/users-reward-pack-opens";
import type { SafeQueryResult } from "@/lib/errors/safe-query";
import { ErrorPill } from "./band-error";
import { TILE_COLORS } from "./user-view-modern-panels";
import {
  OverviewTab,
  FinancesTab,
  FundsTab,
  RewardsTab,
  GamingTab,
  InventoryTab,
  AffiliateTab,
  AccountTab,
} from "./user-view-modern-tabs";
import { TrustTab } from "./user-tabs-trust";
import { FadeIn } from "@/components/fade-in";
import { DURATION, SkeletonTable, SkeletonCard } from "@/components/ux";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ChangeRoleDialog,
  EditIdentityButton,
  ResetRoleToUserButton,
} from "./user-tabs-dialogs";
import { UserAdminActions } from "./user-tabs-moderation";
import { HeroQuickActions } from "./user-hero-quick-actions";
import { UserHeroSticky } from "./user-hero-sticky";
import { CopyButton } from "@/components/copy-button";
import {
  type RiskScoreBreakdown,
  RISK_TIER_COLORS,
  tierLabel,
} from "@/lib/fraud/score-types";

// ---------------------------------------------------------------------------
// Re-exports — preserve the public surface so call sites that previously
// imported from this module keep working.
// ---------------------------------------------------------------------------
export {
  OverviewTab,
  FinancesTab,
  FundsTab,
  RewardsTab,
  GamingTab,
  InventoryTab,
  AffiliateTab,
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

import type { TabKey } from "./user-tabs-types";

type TabDef = {
  key: TabKey;
  label: string;
  icon: React.ElementType;
  // Show conditionally (e.g. creator tab only if user has affiliate code)
  show?: (data: UserDetail) => boolean;
};

const TABS: TabDef[] = [
  { key: "overview", label: "Overview", icon: Activity },
  { key: "gaming", label: "Gaming", icon: Swords },
  { key: "finances", label: "Finances", icon: Wallet },
  // Funds trace — where the user's money came from + which wager it
  // carries. Sits next to Finances (both are money surfaces): Finances
  // is the raw deposit/withdrawal ledger, Funds is the provenance +
  // wager-attribution view built on the sweepstakes source columns.
  { key: "funds", label: "Funds", icon: GitBranch },
  // Inventory sits next to the money surfaces (Finances / Funds) — it now
  // also carries the card-sale cash-out ledger (card_sale / reward_card_sale),
  // moved off the Gaming tab per owner, alongside the owned + sold/exchanged
  // items those sales come from.
  { key: "inventory", label: "Inventory", icon: Gem },
  { key: "rewards", label: "Rewards", icon: Gift },
  { key: "trust", label: "Trust", icon: ShieldAlert },
  // Affiliate tab is ALWAYS visible — admins need to be able to give
  // a user a referral code (set their `referred_by`) regardless of
  // whether the user has their own code yet. This supersedes the
  // earlier visibility check `Boolean(user.affiliateCode) || affiliate !== null`
  // because that still hid the tab from regular users with no
  // referral activity yet, which is exactly when admins need to
  // assign one.
  { key: "affiliate", label: "Affiliate", icon: Sparkles },
  { key: "account", label: "Account", icon: ShieldCheck },
];

export function UserViewModern({
  data,
  backSlot,
  tagsSlot,
  pnlResultPromise,
  riskResultPromise,
  gamingTxPromise,
  shardWinningsPromise,
  shardPackOpensPromise,
  xpPurchasesPromise,
  financialTxPromise,
  adjustmentsTxPromise,
  rewardsPromise,
  rewardPackOpensPromise,
  notesPromise,
  inventoryPromise,
  disposedInventoryPromise,
  cardSaleTxPromise,
  battleVoucherTxPromise,
  sharedIpsPromise,
  sharedFingerprintsPromise,
  wagerRequirementPromise,
  wagerProgressPromise,
  viewerIsAdjustmentOwner,
  initialTab,
}: {
  data: UserDetail;
  // Compact back-to-users button (icon) + the VIP tag manager, both
  // pre-rendered as serializable React elements in page.tsx and threaded in
  // here so they render INSIDE the identity hero — the back button tucked
  // top-left, the tags inline below the badges — instead of as the old
  // standalone top identity strip + full-width tag row.
  backSlot: React.ReactNode;
  tagsSlot: React.ReactNode;
  // ── Streamed-band contract (reliability remake) ──────────────────────
  // Every band promise resolves to a WHOLE SafeQueryResult ({ data, error })
  // — nothing is unwrapped server-side anymore, so each band can render
  // data, an explicit empty state, or a VISIBLE error (never a silent
  // empty). `null` = the query was not kicked for the active tab
  // (Active-Timeframe-Only); the band shows its skeleton and the URL-driven
  // tab switch re-renders the server component which kicks it. The
  // promises never reject (safeQuery), so no client error boundaries are
  // needed around the `use()` sites.
  //
  // Always kicked (tab-independent — they feed the hero + cross-tab P&L):
  pnlResultPromise: Promise<SafeQueryResult<PnlBreakdown>>;
  riskResultPromise: Promise<SafeQueryResult<RiskScoreBreakdown>>;
  // Overview + Gaming:
  gamingTxPromise: Promise<SafeQueryResult<PaginatedTransactions>> | null;
  // Gaming tab only — per-user shard/coin winnings tagged by source game.
  // null = not kicked for the active tab (Active-Timeframe-Only).
  shardWinningsPromise: Promise<SafeQueryResult<ShardWinningsResult>> | null;
  // Gaming tab only — per-user shard-PACK opens (shards spent + value won).
  // null = not kicked for the active tab (Active-Timeframe-Only).
  shardPackOpensPromise: Promise<SafeQueryResult<ShardPackOpensResult>> | null;
  // Finances tab only — per-user XP purchases (USD balance spent to buy XP).
  // null = not kicked for the active tab (Active-Timeframe-Only).
  xpPurchasesPromise: Promise<SafeQueryResult<UserXpPurchasesResult>> | null;
  // Overview + Finances:
  financialTxPromise: Promise<SafeQueryResult<PaginatedTransactions>> | null;
  // Overview, owner only — dedicated uncapped admin_balance_adjustment page
  // (see page.tsx ADJ_LIMIT) so the Overview tab can surface every
  // adjustment without the shared financial page hiding older ones behind
  // newer activity. Non-owners receive a resolved empty page (the server
  // gate in getUserTransactions stays the authority).
  adjustmentsTxPromise: Promise<SafeQueryResult<PaginatedTransactions>> | null;
  // Rewards tab:
  rewardsPromise: Promise<SafeQueryResult<UserRewards>> | null;
  // Rewards tab — reward / sign-up pack opens (welcome/level/daily packs) and
  // the cards each granted. null = not kicked for the active tab
  // (Active-Timeframe-Only). The section self-hides when the user has no
  // reward-pack-sourced inventory.
  rewardPackOpensPromise: Promise<
    SafeQueryResult<UserRewardPackOpensResult>
  > | null;
  // Account tab:
  notesPromise: Promise<SafeQueryResult<AdminNote[]>> | null;
  // Inventory tab:
  inventoryPromise: Promise<SafeQueryResult<PaginatedInventory>> | null;
  disposedInventoryPromise: Promise<SafeQueryResult<PaginatedInventory>> | null;
  // Inventory tab — card-sale cash-out ledger (card_sale / reward_card_sale),
  // moved off Gaming. null = tab not active (Active-Timeframe-Only).
  cardSaleTxPromise: Promise<SafeQueryResult<PaginatedTransactions>> | null;
  battleVoucherTxPromise: Promise<SafeQueryResult<PaginatedTransactions>> | null;
  // Trust tab:
  sharedIpsPromise: Promise<SafeQueryResult<SharedIdentityUser[]>> | null;
  sharedFingerprintsPromise: Promise<SafeQueryResult<SharedIdentityUser[]>> | null;
  // Account tab — per-user withdrawal wager-requirement override (backend
  // API, NOT the MAIN DB; plain nullable value, its own catch→null wrapper
  // in page.tsx). null resolution = the card's muted degraded state.
  wagerRequirementPromise: Promise<UserWagerRequirement | null> | null;
  // Account tab — read-only wager-requirement PROGRESS derived from the
  // backend-written `balances` columns (dev-only). null = prod / no-balance /
  // read failed → the card's muted "not available" state.
  wagerProgressPromise: Promise<UserWagerProgress | null> | null;
  // True only for the owner `motha`. Defence-in-depth UI flag: when false the
  // Finances type-filter dropdown drops the "admin balance adjustment" option
  // so a non-owner never even sees the category label. The real boundary is
  // server-side (getUserTransactions returns no adjustment rows for non-owners).
  viewerIsAdjustmentOwner: boolean;
  // Tab seeded from the ?tab= URL param. Tab clicks update BOTH the local
  // state (instant pill switch) and the URL (router.replace inside a
  // transition) — the server re-render against the new ?tab= kicks exactly
  // that tab's queries. Deep-links and back/forward stay correct because
  // this prop re-syncs the pill on every new server payload.
  initialTab: TabKey;
}) {
  const { user, balances, counts, capabilities } = data;
  const isAdmin = data.sessionRole === "admin";
  const canChangeUserRoles = capabilities.canChangeUserRoles;
  const router = useRouter();
  const pathname = usePathname();
  const [activeTab, setActiveTab] = useState<TabKey>(initialTab);
  // Transition for the URL write so the optimistic pill switch is never
  // blocked by the server round-trip (React keeps the previous content
  // visible while the new tab's band streams in — boundaries aren't
  // re-keyed, so there's no fallback flash on refresh).
  const [, startTabTransition] = useTransition();

  // Keep the pill in sync with the URL on every new server payload —
  // back/forward navigation and external deep-links change ?tab= without a
  // click, and the kicked band promises follow the URL. Without this sync
  // the visible tab could point at bands whose queries were never kicked
  // (permanent skeletons). After an optimistic click this is a no-op (the
  // payload's initialTab matches what was already set).
  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  const handleTabChange = useCallback(
    (k: TabKey) => {
      setActiveTab(k); // instant optimistic pill switch
      startTabTransition(() => {
        // URL is the source of truth for which tab's queries get kicked —
        // the server re-render against ?tab=k streams that tab's bands.
        // `scroll: false` keeps the operator's scroll position.
        router.replace(`${pathname}?tab=${k}`, { scroll: false });
      });
    },
    [pathname, router],
  );

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

  // ── HERO ──────────────────────────────────────────────────────────
  // Extracted as a node so UserHeroSticky can render it inline AND derive
  // a thin condensed bar (avatar + name + balance) that appears once the
  // hero scrolls out of view. The tab bar's own sticky behaviour is
  // untouched (the condensed bar layers above it on z-index).
  const heroNode = (
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

        <div className="relative p-3 sm:p-5 md:p-6">
          {/* Identity + compact KPI chips on one wrapping row. */}
          <div className="flex flex-wrap items-start gap-3 sm:gap-4">
            <div className="flex min-w-0 flex-1 basis-[min(100%,18rem)] items-start gap-3 sm:gap-4">
              {/* Compact back-to-users button — tucked into the hero's
                  top-left (replaces the standalone back arrow from the
                  now-removed top identity strip). Same /users navigation. */}
              {backSlot}
              <div className="relative shrink-0">
                <Avatar className="size-12 sm:size-14 ring-2 ring-background shadow-lg">
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

              <div className="min-w-0 space-y-1 flex-1">
                {/* Identity — line 1 = username (the big heading), line 2 =
                    email (with its verified ✓ + copy). The redundant @handle
                    duplicate and the old below-the-badges email subline were
                    removed so neither name nor email is shown twice. */}
                <div className="flex items-center gap-1 min-w-0">
                  <h2 className="text-lg sm:text-xl font-bold leading-tight truncate min-w-0">
                    {displayName}
                  </h2>
                  <CopyButton value={displayName} label="Username" />
                </div>
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <span className="truncate">{user.email}</span>
                  {user.emailVerified && (
                    <span className="text-[10px] font-semibold text-emerald-500">
                      ✓
                    </span>
                  )}
                  {user.email && (
                    <CopyButton value={user.email} label="Email" />
                  )}
                </p>
                {/* Admin toolbar — separate row on phone so name doesn't
                    have to share its row with 4+ action buttons that wrap
                    awkwardly. Wraps as needed; on wider screens it sits
                    naturally close to the name without taking extra space. */}
                <div className="flex flex-wrap items-center gap-1.5">
                  <EditIdentityButton user={user} />
                  {/* Quick-link to the creator detail page. Only shown
                      when the viewed user is an on-site creator — the
                      /creators/<id> route shares the same main-site
                      user id space as /users/<id>. */}
                  {user.role === "creator" && (
                    <Link
                      href={`/creators/${user.id}`}
                      className={cn(
                        buttonVariants({ variant: "outline", size: "sm" }),
                        "border-purple-500/40 text-purple-600 dark:text-purple-400 hover:bg-purple-500/10",
                      )}
                    >
                      <Megaphone className="size-3.5" />
                      Creator page
                    </Link>
                  )}
                  {/* Site-role controls — changes the user's role on the
                      game platform (user / creator / support / admin),
                      NOT their admin-panel access. Grouped + labelled so
                      the distinction is unmistakable. */}
                  {canChangeUserRoles && (
                    <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-dashed border-border/70 px-2 py-1">
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Site role
                      </span>
                      <ChangeRoleDialog userId={user.id} currentRole={user.role} />
                      {/* Quick escape hatch when /creators backend demote
                          gets stuck — only renders for current creators. */}
                      <ResetRoleToUserButton
                        userId={user.id}
                        currentRole={user.role}
                      />
                    </div>
                  )}
                  <UserAdminActions
                    user={user}
                    availableBalance={balances?.availableBalance ?? 0}
                    lockedBalance={balances?.lockedBalance ?? 0}
                    unlockAt={balances?.unlockAt ?? null}
                    isAdmin={isAdmin}
                    capabilities={capabilities}
                  />
                  {/* Quick-action cluster — Adjust Balance (existing
                      BalanceAdjustDialog → adjustBalance action, gated on
                      canAdjustBalance) + Add Note (jumps to the Account tab
                      where the tab-kicked NotesSection lives). Ban/lock/vault
                      already render via UserAdminActions above. */}
                  <HeroQuickActions
                    user={user}
                    availableBalance={balances?.availableBalance ?? 0}
                    availableBalanceRaw={
                      balances?.availableBalanceRaw ??
                      balances?.availableBalance ??
                      0
                    }
                    lockedBalance={balances?.lockedBalance ?? 0}
                    canAdjustBalance={
                      isAdmin || capabilities.canAdjustBalance
                    }
                    onOpenAccount={() => handleTabChange("account")}
                    tagsSlot={tagsSlot}
                  />
                </div>
                <div className="flex flex-wrap items-center gap-1 pt-0.5">
                  <Badge
                    variant="outline"
                    className={cn("text-[10px] py-0 h-5", ROLE_COLORS[user.role] ?? "")}
                  >
                    {user.role}
                  </Badge>
                  {/* Ex-creator flag — they aren't a creator now but were
                      one before (audit role-change to creator, or own
                      creator-only affiliate codes). */}
                  {data.wasCreator && (
                    <Badge
                      variant="outline"
                      className="h-5 border-purple-500/40 bg-purple-500/10 py-0 text-[10px] text-purple-600 dark:text-purple-400"
                      title={
                        data.creatorSince
                          ? `Previously had the creator role — creator since ${data.creatorSince.slice(0, 10)}`
                          : "Previously had the creator role"
                      }
                    >
                      Ex-creator
                    </Badge>
                  )}
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
                        ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
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
                  {/* Risk badges — their own streamed island so the heavy
                      fraud scan never blocks the identity hero. On a failed
                      scan the pill reads "Risk —" (unavailable) — NEVER a
                      neutral "Risk 0" false all-clear. */}
                  <Suspense
                    fallback={
                      <Skeleton className="h-5 w-16 rounded-full" />
                    }
                  >
                    <HeroRiskBadges
                      riskResultPromise={riskResultPromise}
                      onOpenTrust={() => handleTabChange("trust")}
                    />
                  </Suspense>
                </div>
                <div className="flex flex-wrap items-center gap-2 pt-1 text-[11px] text-muted-foreground">
                  <span className="inline-flex items-center gap-0.5">
                    <MapPin className="size-2.5" />
                    {user.country ?? user.countryCode ?? "Unknown"}
                  </span>
                  <span className="inline-flex items-center gap-0.5">
                    <Calendar className="size-2.5" />
                    <RelativeTime date={user.createdAt} />
                  </span>
                  {/* User ID — short form shown, FULL id copied. */}
                  <span
                    className="inline-flex items-center gap-1 font-mono"
                    title={user.id}
                  >
                    {user.id.slice(0, 8)}
                    <CopyButton value={user.id} label="User ID" />
                  </span>
                </div>
              </div>
            </div>

            <div className="flex min-w-0 flex-[1.35] flex-wrap items-stretch gap-1.5 content-start sm:gap-2">
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
              {/* Total Depo — lifetime deposited dollars. Pairs
                  with the P&L tile next to it (P&L denominator is
                  effectively this number). Emerald because cash
                  flowing in is a house gain in the moment, matching
                  the Deposited convention used on the dashboard's
                  KPI strip. */}
              <KpiTile
                label="Total Depo"
                value={formatCurrency(deposits)}
                icon={Banknote}
                accent="emerald"
              />
              {/* Total Withdrawn — lifetime withdrawn dollars. Sits directly
                  next to Total Depo so the operator can read "$X deposited
                  − $Y withdrawn" left-to-right and eyeball the realized
                  cash leg of P&L instantly. Rose because a withdrawal is
                  the user pulling money out (user gain = house loss → red
                  per the house-POV finance convention in CLAUDE.md).
                  Sourced from `withdrawals` (balances.totalWithdrawn,
                  i.e. userPnl.withdrawals — the canonical P&L helper that
                  also drives the dashboard's lifetime aggregates), so this
                  view can never drift from users-list / dashboard. */}
              <KpiTile
                label="Total Withdrawn"
                value={formatCurrency(withdrawals)}
                icon={ArrowUpCircle}
                accent="rose"
              />
              {/* Wager Left — weighted wager remaining before this user can
                  withdraw balance. Neutral info (cyan). Streamed so the
                  per-user wager read never blocks the identity hero. */}
              {wagerProgressPromise && (
                <Suspense
                  fallback={
                    <KpiTile
                      label="Wager Left"
                      value="…"
                      icon={Hourglass}
                      accent="cyan"
                    />
                  }
                >
                  <WagerLeftHeroTile promise={wagerProgressPromise} />
                </Suspense>
              )}
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
                accent="rose"
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
  );

  return (
    <div className="space-y-6">
      {/* Hero + scroll-collapse condensed bar (feature: collapse-to-sticky
          on scroll). The bar shows avatar + name + current balance once the
          hero is scrolled past. */}
      <UserHeroSticky
        hero={heroNode}
        avatarImage={user.image ?? null}
        avatarFallback={(user.username ?? user.email ?? "?")
          .slice(0, 2)
          .toUpperCase()}
        displayName={displayName}
        balanceLabel={formatCurrency(balances?.availableBalance ?? 0)}
        statusKey={statusKey}
      />

      {/* ── TAB BAR ──────────────────────────────────────────────────
          On phone the pills horizontal-scroll instead of wrapping into
          two rows; the active tab scrolls itself into view when changed.
          Edge-fade gradients hint at scrollable content. On lg+ screens
          all 8 tabs fit naturally so no scroll needed. */}
      <ScrollableTabBar
        visibleTabs={visibleTabs}
        activeTab={activeTab}
        onChange={handleTabChange}
      />

      {/* ── TAB CONTENT ──────────────────────────────────────────────
          Tab switches flip the pill instantly (optimistic state) AND write
          ?tab= to the URL inside a transition — the server re-render kicks
          exactly the new tab's queries and streams them in. Until that
          payload arrives a band whose promise is still null renders its
          skeleton. FadeIn is keyed on the active tab ONLY (never on data /
          refresh counters) so AutoRefresh re-streams stay flash-free and
          mounted dialogs survive. */}
      <FadeIn key={activeTab} speed="fast">
        {activeTab === "overview" && (
          <OverviewTab
            data={data}
            gamingTxPromise={gamingTxPromise}
            financialTxPromise={financialTxPromise}
            adjustmentsTxPromise={adjustmentsTxPromise}
            pnlResultPromise={pnlResultPromise}
            wagerProgressPromise={wagerProgressPromise}
            isAdmin={isAdmin}
            viewerIsAdjustmentOwner={viewerIsAdjustmentOwner}
          />
        )}

        {activeTab === "finances" && (
          <FinancesTab
            data={data}
            financialTxPromise={financialTxPromise}
            xpPurchasesPromise={xpPurchasesPromise}
            wagerProgressPromise={wagerProgressPromise}
            isAdmin={isAdmin}
            viewerIsAdjustmentOwner={viewerIsAdjustmentOwner}
          />
        )}

        {/* Funds trace — money provenance + wager attribution. Uses the
            always-kicked wagerProgressPromise for the per-source + "which
            wager" sections and the already-resolved data.balances for the
            balance-now KPIs, so it needs no new tab-gated query. */}
        {activeTab === "funds" && (
          <FundsTab data={data} wagerProgressPromise={wagerProgressPromise} />
        )}

        {activeTab === "rewards" && (
          <RewardsTab
            rewardsPromise={rewardsPromise}
            rewardPackOpensPromise={rewardPackOpensPromise}
          />
        )}

        {activeTab === "gaming" && (
          <GamingTab
            data={data}
            gamingTxPromise={gamingTxPromise}
            shardWinningsPromise={shardWinningsPromise}
            shardPackOpensPromise={shardPackOpensPromise}
          />
        )}

        {activeTab === "inventory" && (
          <InventoryTab
            data={data}
            inventoryPromise={inventoryPromise}
            disposedInventoryPromise={disposedInventoryPromise}
            cardSaleTxPromise={cardSaleTxPromise}
            battleVoucherTxPromise={battleVoucherTxPromise}
          />
        )}

        {activeTab === "trust" && (
          // The whole Trust tab depends on the shared-identity fan-out +
          // the risk scan; all three legs travel as SafeQueryResults so a
          // failed leg renders a visible band error inside the tab. Null
          // promises (tab not yet kicked) → fallback skeleton until the
          // URL-driven re-render streams them.
          (sharedIpsPromise && sharedFingerprintsPromise ? (
            <Suspense fallback={<TrustTabFallback />}>
              <TrustTabStreamed
                userId={user.id}
                riskResultPromise={riskResultPromise}
                sharedIpsPromise={sharedIpsPromise}
                sharedFingerprintsPromise={sharedFingerprintsPromise}
              />
            </Suspense>
          ) : (
            <TrustTabFallback />
          ))
        )}

        {activeTab === "affiliate" && <AffiliateTab data={data} />}

        {activeTab === "account" && (
          <AccountTab
            data={data}
            notesPromise={notesPromise}
            pnlResultPromise={pnlResultPromise}
            wagerRequirementPromise={wagerRequirementPromise}
            wagerProgressPromise={wagerProgressPromise}
          />
        )}
      </FadeIn>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────
//  WAGER-LEFT HERO TILE — streamed island
//
//  Surfaces the remaining weighted wager before withdrawal as a hero KPI,
//  so an operator sees "how far from cashing out" without opening the
//  Account tab. use()s the always-kicked wager-progress promise; null /
//  exempt / met / backend-unavailable each render a clear state. Neutral
//  (cyan) — "wager left" is informational, not a house gain/loss.
// ───────────────────────────────────────────────────────────────────

function WagerLeftHeroTile({
  promise,
}: {
  promise: Promise<UserWagerProgress | null>;
}) {
  const wp = use(promise);
  if (!wp) {
    return (
      <KpiTile label="Wager Left" value="—" sub="no data" icon={Hourglass} accent="cyan" />
    );
  }
  if (wp.exempt) {
    return (
      <KpiTile label="Wager Left" value="Exempt" sub="0× requirement" icon={Hourglass} accent="cyan" />
    );
  }
  if (wp.remainingUsd == null) {
    return (
      <KpiTile label="Wager Left" value="—" sub="needs backend" icon={Hourglass} accent="cyan" />
    );
  }
  if (wp.remainingUsd <= 0) {
    return (
      <KpiTile label="Wager Left" value="Met ✓" sub="can withdraw" icon={Hourglass} accent="cyan" />
    );
  }
  return (
    <KpiTile
      label="Wager Left"
      value={formatCurrency(wp.remainingUsd)}
      sub="to withdraw"
      icon={Hourglass}
      accent="cyan"
    />
  );
}

// ───────────────────────────────────────────────────────────────────
//  HERO RISK BADGES — streamed island
//
//  `use()`s the always-kicked risk SafeQueryResult so the identity hero
//  paints without waiting on the fraud scan. Three states:
//    pending  → pill skeleton (Suspense fallback at the call site),
//    error    → amber "Risk —" pill (unavailable ≠ low risk),
//    success  → the same risk + shared-IP badges as before, both opening
//               the Trust tab via the URL-driven tab switch.
// ───────────────────────────────────────────────────────────────────

function HeroRiskBadges({
  riskResultPromise,
  onOpenTrust,
}: {
  riskResultPromise: Promise<SafeQueryResult<RiskScoreBreakdown>>;
  onOpenTrust: () => void;
}) {
  const r = use(riskResultPromise);
  if (r.error) {
    return (
      <ErrorPill
        label="Risk —"
        title="Risk score unavailable — the fraud scan failed or timed out. This is a load failure, not a low-risk signal."
      />
    );
  }
  const riskBreakdown = r.data;
  return (
    <>
      <button
        type="button"
        onClick={onOpenTrust}
        className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-full"
        aria-label={`Risk score ${riskBreakdown.score} of 100 — ${tierLabel(riskBreakdown.tier)}. Open Trust tab.`}
      >
        <Badge
          variant="outline"
          className={cn(
            "text-[10px] py-0 h-5 cursor-pointer",
            RISK_TIER_COLORS[riskBreakdown.tier],
          )}
        >
          <ShieldAlert className="mr-0.5 size-2.5" />
          Risk {riskBreakdown.score}
        </Badge>
      </button>
      {riskBreakdown.sharedIpCount >= 2 && (
        <button
          type="button"
          onClick={onOpenTrust}
          className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-full"
          aria-label={`Shared IP with ${riskBreakdown.sharedIpCount} other accounts. Open Trust tab.`}
        >
          <Badge
            variant="outline"
            className={cn(
              "text-[10px] py-0 h-5 cursor-pointer",
              riskBreakdown.sharedIpCount >= 5
                ? "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30"
                : "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
            )}
          >
            <Link2 className="mr-0.5 size-2.5" />
            {riskBreakdown.sharedIpCount} shared IP
          </Badge>
        </button>
      )}
    </>
  );
}

// ───────────────────────────────────────────────────────────────────
//  TAB BAR — horizontal-scroll on phone, fits naturally on lg+
// ───────────────────────────────────────────────────────────────────

function ScrollableTabBar({
  visibleTabs,
  activeTab,
  onChange,
}: {
  visibleTabs: TabDef[];
  activeTab: TabKey;
  onChange: (k: TabKey) => void;
}) {
  const scrollerRef = React.useRef<HTMLDivElement | null>(null);
  const tabRefs = React.useRef<Map<TabKey, HTMLButtonElement>>(new Map());
  // Brief highlight on the freshly-activated pill so the silent auto-scroll
  // (below) gets visible feedback — the tab that just moved into view reads
  // as "this is the one you landed on". Holds the active key for one
  // DURATION.base tick, then clears so the ring fades back out. Purely
  // cosmetic + fully `motion-safe:` gated at the render site, so
  // reduced-motion users never see the ring appear or tween.
  const [pulseKey, setPulseKey] = useState<TabKey | null>(null);
  // Skip the pulse on first mount — the initial tab is already in view, so a
  // pulse there would fire on every page load rather than on an actual
  // tab change. Only pulse once the user (or a deep-link badge) switches.
  const mountedRef = React.useRef(false);

  // Scroll active pill into view on phone — keeps the user oriented when
  // they tap a tab that was previously off-screen — then pulse it so the
  // landing is noticeable.
  useEffect(() => {
    const el = tabRefs.current.get(activeTab);
    if (!el) return;
    el.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
      inline: "center",
    });
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    setPulseKey(activeTab);
    const t = window.setTimeout(() => setPulseKey(null), DURATION.base);
    return () => window.clearTimeout(t);
  }, [activeTab]);

  return (
    <div className="sticky top-0 z-20 rounded-xl border bg-card/80 p-1 backdrop-blur-md">
      <div className="relative">
        {/* Edge fade hints — only visible while scrollable, but cheaper to
            always render than to compute scroll position with a ResizeObserver. */}
        <div
          aria-hidden
          className="pointer-events-none absolute left-0 top-0 bottom-0 w-6 bg-gradient-to-r from-card/80 to-transparent rounded-l-xl lg:hidden"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute right-0 top-0 bottom-0 w-6 bg-gradient-to-l from-card/80 to-transparent rounded-r-xl lg:hidden"
        />
        <div
          ref={scrollerRef}
          className="flex gap-1 overflow-x-auto lg:flex-wrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {visibleTabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.key;
            const isPulsing = pulseKey === tab.key;
            return (
              <button
                key={tab.key}
                ref={(el) => {
                  if (el) tabRefs.current.set(tab.key, el);
                  else tabRefs.current.delete(tab.key);
                }}
                onClick={() => onChange(tab.key)}
                className={cn(
                  "inline-flex shrink-0 items-center gap-1.5 sm:gap-2 rounded-lg px-3 sm:px-4 py-2 text-sm font-medium transition-all min-h-[44px]",
                  isActive
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  // One-shot landing pulse: a contrasting ring that appears
                  // for DURATION.base then fades via the button's existing
                  // `transition-all`. `motion-safe:` gates the ring entirely
                  // so reduced-motion users see no transient highlight.
                  isPulsing &&
                    "motion-safe:ring-2 motion-safe:ring-primary-foreground/50 motion-safe:ring-offset-0",
                )}
              >
                <Icon className="size-4" />
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────
//  TRUST TAB — streamed wrapper + fallback
//
//  The Trust tab's shared-IP / shared-fingerprint lists come from a
//  tab-gated fan-out (kicked only when ?tab=trust is active) and the risk
//  scan is the always-kicked hero read. All three travel as WHOLE
//  SafeQueryResults — TrustTab renders a visible per-leg error instead of
//  "no shared accounts" / a neutral low-risk hero when a leg failed.
//  Only mounted when the Trust tab is active, inside a <Suspense>.
// ───────────────────────────────────────────────────────────────────

function TrustTabStreamed({
  userId,
  riskResultPromise,
  sharedIpsPromise,
  sharedFingerprintsPromise,
}: {
  userId: string;
  riskResultPromise: Promise<SafeQueryResult<RiskScoreBreakdown>>;
  sharedIpsPromise: Promise<SafeQueryResult<SharedIdentityUser[]>>;
  sharedFingerprintsPromise: Promise<SafeQueryResult<SharedIdentityUser[]>>;
}) {
  const riskResult = use(riskResultPromise);
  const ipsResult = use(sharedIpsPromise);
  const fpsResult = use(sharedFingerprintsPromise);
  return (
    <TrustTab
      userId={userId}
      breakdown={riskResult.data}
      breakdownError={riskResult.error}
      sharedIps={ipsResult.data}
      sharedIpsError={ipsResult.error}
      sharedFingerprints={fpsResult.data}
      sharedFingerprintsError={fpsResult.error}
    />
  );
}

// Skeleton shaped to the Trust tab while its identity fan-out streams in:
// a stat-style header line + the shared-IP / shared-fingerprint tables.
function TrustTabFallback() {
  return (
    <div className="space-y-6" aria-busy="true">
      <div className="flex items-center gap-2">
        <Skeleton className="size-7 shrink-0 rounded-md" />
        <Skeleton className="h-5 w-40" />
      </div>
      <SkeletonCard lines={3} />
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Skeleton className="size-7 shrink-0 rounded-md" />
          <Skeleton className="h-5 w-32" />
        </div>
        <SkeletonTable rows={4} columns={4} />
      </div>
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
        "group relative min-w-0 flex-[1_1_6.25rem] max-w-[8.75rem] overflow-hidden rounded-lg border px-2 py-1.5 transition-all hover:shadow-sm sm:flex-[1_1_6.75rem] sm:px-2.5 sm:py-2",
        colors.bg,
      )}
    >
      <div className="flex items-center gap-1">
        <Icon className={cn("size-3 shrink-0", colors.icon)} />
        <span className="truncate text-[9px] font-semibold uppercase tracking-wider text-muted-foreground sm:text-[10px]">
          {label}
        </span>
      </div>
      <p
        className={cn(
          "mt-0.5 truncate text-sm font-bold tabular-nums leading-tight sm:text-base",
          colors.text,
        )}
      >
        {value}
      </p>
      {sub && (
        <p className="mt-0.5 truncate text-[9px] text-muted-foreground sm:text-[10px]">
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
