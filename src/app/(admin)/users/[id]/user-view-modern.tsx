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
  Activity,
  Hourglass,
  Sparkles,
  Percent,
  Calendar,
  MapPin,
  Megaphone,
  Ban,
  Lock,
  Ticket,
  ShieldBan,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { formatCurrency, formatCompactUsd, formatDateTime } from "@/lib/utils/format";
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
import type { UserWagerRequirement } from "@/lib/backend-api/wager-requirements";
import type { UserFeatureLocks } from "@/lib/backend-api/feature-locks";
import type { UserKycStatus } from "@/lib/backend-api/kyc";
import type { UserWagerProgress } from "@/lib/queries/users-wager-progress";
import type { UserBalanceWeighting } from "@/lib/queries/users-balance-weighting";
import type { UserRewardPackOpensResult } from "@/lib/queries/users-reward-pack-opens";
import type { SafeQueryResult } from "@/lib/errors/safe-query";
import { TILE_COLORS } from "./user-view-modern-panels";
import {
  OverviewTab,
  RewardsTab,
  GamingTab,
  InventoryTab,
  AccountTab,
} from "./user-view-modern-tabs";
import { FadeIn } from "@/components/fade-in";
import { DURATION } from "@/components/ux";
import {
  ChangeRoleDialog,
  ResetRoleToUserButton,
} from "./user-tabs-dialogs";
import { UserAdminActions } from "./user-tabs-moderation";
import { UserHeroSticky } from "./user-hero-sticky";
import { CopyButton } from "@/components/copy-button";

// ---------------------------------------------------------------------------
// Re-exports — preserve the public surface so call sites that previously
// imported from this module keep working.
// ---------------------------------------------------------------------------
export {
  OverviewTab,
  RewardsTab,
  GamingTab,
  InventoryTab,
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
  // Inventory carries the card-sale cash-out ledger (card_sale /
  // reward_card_sale), moved off the Gaming tab per owner, alongside the
  // owned + sold/exchanged items those sales come from.
  { key: "inventory", label: "Inventory", icon: Gem },
  { key: "rewards", label: "Rewards", icon: Gift },
  // Affiliate data now lives as its own section INSIDE the Account tab (the
  // separate Affiliate tab was folded in) — admins still manage a user's
  // referral code there. Account is the catch-all for account-level admin
  // surfaces (moderation, feature locks, wager req, affiliate).
  { key: "account", label: "Account", icon: ShieldCheck },
];

// ---------------------------------------------------------------------------
// Self-exclusion state derivation (responsible-gambling). USER-initiated on
// the game platform — DISPLAY-ONLY in the admin. The raw flag is sticky: a
// user keeps `isSelfExcluded = true` even after the window lapses, so we
// derive the live state from the `until` timestamp:
//   • "none"    → not self-excluded (no chip / badge)
//   • "active"  → window still open (or open-ended) → CURRENTLY restricted
//   • "expired" → flag set but `until` is in the past → restriction lapsed
// ---------------------------------------------------------------------------
type SelfExclusionState = "none" | "active" | "expired";

function deriveSelfExclusion(
  isSelfExcluded: boolean,
  selfExcludedUntil: string | null,
): SelfExclusionState {
  if (!isSelfExcluded) return "none";
  if (!selfExcludedUntil) return "active"; // open-ended exclusion
  return new Date(selfExcludedUntil).getTime() > Date.now()
    ? "active"
    : "expired";
}

export function UserViewModern({
  data,
  backSlot,
  tagsSlot,
  pnlResultPromise,
  gamingTxPromise,
  financialTxPromise,
  adjustmentsTxPromise,
  rewardsPromise,
  rewardPackOpensPromise,
  notesPromise,
  inventoryPromise,
  disposedInventoryPromise,
  cardSaleTxPromise,
  battleVoucherTxPromise,
  wagerRequirementPromise,
  featureLocksPromise,
  kycPromise,
  wagerProgressPromise,
  balanceWeightingPromise,
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
  // Overview + Gaming:
  gamingTxPromise: Promise<SafeQueryResult<PaginatedTransactions>> | null;
  // Overview — deposits & withdrawals feed:
  financialTxPromise: Promise<SafeQueryResult<PaginatedTransactions>> | null;
  // Account tab, owner only — dedicated uncapped admin_balance_adjustment page
  // (see page.tsx ADJ_LIMIT) so the Account tab can surface every
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
  // Account tab — per-user withdrawal wager-requirement override (backend
  // API, NOT the MAIN DB; plain nullable value, its own catch→null wrapper
  // in page.tsx). null resolution = the card's muted degraded state.
  wagerRequirementPromise: Promise<UserWagerRequirement | null> | null;
  // Account tab — backend-owned fraud-signal deposit/withdrawal locks
  // (card refund/chargeback). Same catch→null convention as the
  // wager-requirement override above.
  featureLocksPromise: Promise<UserFeatureLocks | null> | null;
  // Account tab — backend-owned Sumsub KYC status + admin control. Same
  // catch→null convention as the fraud-locks read above.
  kycPromise: Promise<UserKycStatus | null> | null;
  // Account tab — read-only wager-requirement PROGRESS derived from the
  // backend-written `balances` columns (dev-only). null = prod / no-balance /
  // read failed → the card's muted "not available" state.
  wagerProgressPromise: Promise<UserWagerProgress | null> | null;
  // Account tab — how each part of the balance is weighted toward each
  // destination (funding-source wager-weight matrix × this user's balance
  // composition). null = tab not active / read failed → muted card.
  balanceWeightingPromise: Promise<UserBalanceWeighting | null> | null;
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
  const { user, balances, capabilities } = data;
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

  // Self-exclusion (responsible-gambling) — USER-initiated on the game
  // platform, DISPLAY-ONLY here. A user can carry `isSelfExcluded` while the
  // `until` timestamp is already in the PAST = EXPIRED (the flag is sticky;
  // the restriction has lapsed). "active" means the exclusion window is still
  // open → the user is CURRENTLY restricted on the game platform (the betting/
  // withdrawal routes 403 for them). No `until` → treat as active (open-ended).
  const selfExclusion = deriveSelfExclusion(
    user.isSelfExcluded,
    user.selfExcludedUntil,
  );

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

  // The hero KPI tiles sit in a dense capped-width 4-col grid on the lg
  // band (~1024–1280px), where a full-precision 6/7-figure currency string
  // ("$2,345,678.90" / "-$456,789.22") overflows the tile and gets clipped
  // by `truncate`, hiding the most significant digits. For values at/above
  // $100K we render the compact form ("$2.3M" / "$456.8K") so the magnitude
  // stays fully readable in the tile; the EXACT figure is always one panel
  // down in the Overview Balances / Platform-P&L panels (full
  // `formatCurrency`). Below $100K — the overwhelming majority of real
  // users — the tile fits, so we keep the exact dollars-and-cents value.
  // Sign is preserved for P&L by the formatter.
  const heroMoney = (v: number): string =>
    Math.abs(v) >= 100_000 ? formatCompactUsd(v) : formatCurrency(v);

  // ── HERO ──────────────────────────────────────────────────────────
  // Extracted as a node so UserHeroSticky can render it inline AND derive
  // a thin condensed bar (avatar + name + balance) that appears once the
  // hero scrolls out of view. The tab bar's own sticky behaviour is
  // untouched (the condensed bar layers above it on z-index).
  const heroNode = (
    <div className="rounded-xl border bg-card shadow-sm">
        {/* Flat hero: solid bg-card + hairline border + a single very soft
            shadow. The gradient fill and the two corner-glow blobs were the
            layered depth noise the cleaner/flatter pilot removes. */}
        <div className="p-3 sm:p-4">
          {/* Hero = balanced two-column header on lg+: identity on the LEFT,
              a compact KPI tile grid on the RIGHT. Below lg the two columns
              stack (identity, then tiles) so phones get a clean vertical
              flow. This keeps the hero SHORT — the tiles sit beside the
              identity instead of adding a tall second block underneath.
              Padding + gaps were tightened (owner 2026-07-11: hero read as
              "too big") on top of the tile-count reduction below. */}
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:gap-5">
            <div className="flex min-w-0 flex-1 items-start gap-3 sm:gap-4">
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
                    isAdmin={isAdmin}
                    capabilities={capabilities}
                  />
                  {/* VIP tags dropdown — pre-rendered in page.tsx and
                      threaded in as a serializable ReactNode. Adjust
                      Balance / Add Note quick actions were removed from
                      the hero (owner 2026-07-12) — Adjust Balance still
                      lives in the Overview tab's Balance panel. Ban/unban/
                      lock render via UserAdminActions above; the "To vault"
                      action was removed from the hero entirely per owner
                      request. */}
                  {tagsSlot}
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
                  {/* Self-exclusion (responsible-gambling) — surfaced next to
                      the moderation status so a support admin sees a restricted
                      account at a glance. ACTIVE = rose (currently restricted on
                      the game platform); EXPIRED = amber (flag set but the window
                      has lapsed). USER-initiated + DISPLAY-ONLY (no admin action
                      imposes/lifts it). Full detail (since / until / reason) is
                      on the Account tab's Moderation card. */}
                  {selfExclusion === "active" && (
                    <Badge
                      variant="outline"
                      className="text-[10px] py-0 h-5 border-rose-500/30 bg-rose-500/15 text-rose-600 dark:text-rose-400"
                      title={
                        user.selfExcludedUntil
                          ? `Self-excluded until ${formatDateTime(user.selfExcludedUntil)} — currently restricted on the game platform`
                          : "Self-excluded (open-ended) — currently restricted on the game platform"
                      }
                    >
                      <ShieldBan className="mr-0.5 size-2.5" />
                      Self-Excluded
                    </Badge>
                  )}
                  {selfExclusion === "expired" && (
                    <Badge
                      variant="outline"
                      className="text-[10px] py-0 h-5 border-amber-500/30 bg-amber-500/15 text-amber-600 dark:text-amber-400"
                      title={
                        user.selfExcludedUntil
                          ? `Self-exclusion expired ${formatDateTime(user.selfExcludedUntil)} — no longer restricted`
                          : "Self-exclusion expired — no longer restricted"
                      }
                    >
                      <ShieldBan className="mr-0.5 size-2.5" />
                      Self-Excl. (expired)
                    </Badge>
                  )}
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

                {/* ── FLAGS STRIP ──────────────────────────────────────
                    A compact, one-row (wrap-safe) strip surfacing the most
                    important ACTIVE user states at a glance, so an operator
                    doesn't have to scan the breakdown rows below. Every chip
                    is gated on a REAL signal already fetched for this view —
                    no new query, no fabricated flag. The strip collapses to
                    nothing when the user is clean (active, no held vouchers,
                    exempt/unavailable wager). House-POV coloring per
                    CLAUDE.md. */}
                <HeroFlagsStrip
                  statusKey={statusKey}
                  selfExclusion={selfExclusion}
                  vouchersValue={vouchersValue}
                />
              </div>
            </div>

            {/* KPI tiles — compact RIGHT column on lg+ (sits beside the
                identity, keeping the hero short), full-width below lg. Five
                equal-width tiles that fit in ONE row from sm+ up
                (grid-cols-5), down from the previous 2-row / 8-cell grid.
                Deposits/Withdrawals $ totals + counts were dropped from the
                hero (owner 2026-07-11: "deposits / withdrawals i can also
                see below on platform pl ... so its double data for
                nothing") — both figures are already shown verbatim in the
                Platform P&L panel (Deposited/Withdrawn) and the avg-deposit
                figure in the Activity panel, further down the Overview tab.
                This hero now only surfaces numbers that live nowhere else
                on the page. On phone (2-col) the 5th tile spans the full
                row so the last row never leaves a dangling empty cell. */}
            <div className="grid w-full grid-cols-2 gap-2 sm:grid-cols-5 lg:w-[clamp(26rem,40vw,38rem)] lg:shrink-0">
              <KpiTile
                label="Total Value"
                value={heroMoney(totalValue)}
                icon={Wallet}
                accent="blue"
              />
              <KpiTile
                label="P&L"
                value={`${pnl >= 0 ? "+" : ""}${heroMoney(pnl)}`}
                icon={pnl >= 0 ? TrendingUp : TrendingDown}
                accent={pnl >= 0 ? "emerald" : "rose"}
              />
              {/* Wager Left — weighted wager remaining before this user can
                  withdraw balance. Neutral info (cyan). Streamed so the
                  per-user wager read never blocks the identity hero. The
                  Suspense wraps this single grid cell so the cell stays
                  uniform (its fallback is the same KpiTile). */}
              {wagerProgressPromise ? (
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
              ) : (
                <KpiTile
                  label="Wager Left"
                  value="—"
                  sub="no data"
                  icon={Hourglass}
                  accent="cyan"
                />
              )}
              <KpiTile
                label="Multiplier"
                value={wagerMultiplier > 0 ? `${wagerMultiplier.toFixed(2)}×` : "—"}
                sub="wager / deposit"
                icon={Coins}
                accent="amber"
              />
              {/* Last tile — spans both mobile columns so a 5-tile grid on
                  a 2-col phone layout ends on a full-width row instead of
                  leaving one empty cell dangling next to it. Reverts to a
                  normal single cell from sm+ where the grid is 5-wide. */}
              <div className="col-span-2 sm:col-span-1">
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
            financialTxPromise={financialTxPromise}
            pnlResultPromise={pnlResultPromise}
            wagerProgressPromise={wagerProgressPromise}
            isAdmin={isAdmin}
            viewerIsAdjustmentOwner={viewerIsAdjustmentOwner}
          />
        )}

        {activeTab === "rewards" && (
          <RewardsTab
            rewardsPromise={rewardsPromise}
            rewardPackOpensPromise={rewardPackOpensPromise}
            tips={data.tips}
          />
        )}

        {activeTab === "gaming" && (
          <GamingTab data={data} gamingTxPromise={gamingTxPromise} />
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

        {activeTab === "account" && (
          <AccountTab
            data={data}
            notesPromise={notesPromise}
            pnlResultPromise={pnlResultPromise}
            wagerRequirementPromise={wagerRequirementPromise}
            featureLocksPromise={featureLocksPromise}
            kycPromise={kycPromise}
            wagerProgressPromise={wagerProgressPromise}
            balanceWeightingPromise={balanceWeightingPromise}
            adjustmentsTxPromise={adjustmentsTxPromise}
            viewerIsAdjustmentOwner={viewerIsAdjustmentOwner}
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
  // remainingUsd is the authoritative frozen debt (always column-sourced now,
  // never null) — 0 means the requirement is met and the balance is free.
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
//  HERO FLAGS STRIP — compact one-row strip of ACTIVE user-state chips
//
//  Surfaces the highest-signal states at a glance. Every chip is gated on
//  a REAL signal already fetched for this view (no new query, nothing
//  fabricated) and only renders when its condition is TRUE — the strip
//  collapses to nothing for a clean user. House-POV coloring (CLAUDE.md):
//    • Banned / Locked     → rose  (account is restricted)
//    • Unclaimed vouchers   → rose  (user holds value = house liability)
//  Wager requirement is deliberately NOT a chip here — the hero's dedicated
//  "Wager Left" KPI tile already surfaces it, so a chip would duplicate it.
// ───────────────────────────────────────────────────────────────────

function FlagChip({
  icon: Icon,
  label,
  className,
  title,
}: {
  icon: React.ElementType;
  label: string;
  className: string;
  title?: string;
}) {
  return (
    <Badge
      variant="outline"
      className={cn("h-5 gap-0.5 py-0 text-[10px]", className)}
      title={title}
    >
      <Icon className="size-2.5" />
      {label}
    </Badge>
  );
}

function HeroFlagsStrip({
  statusKey,
  selfExclusion,
  vouchersValue,
}: {
  statusKey: "active" | "locked" | "banned";
  selfExclusion: SelfExclusionState;
  vouchersValue: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1 pt-1.5">
      {/* Account status — only when restricted (banned/locked). Active =
          no chip (the green status badge above already conveys "clean"). */}
      {statusKey === "banned" && (
        <FlagChip
          icon={Ban}
          label="Banned"
          className="border-rose-500/30 bg-rose-500/15 text-rose-600 dark:text-rose-400"
          title="Account is banned"
        />
      )}
      {statusKey === "locked" && (
        <FlagChip
          icon={Lock}
          label="Locked"
          className="border-rose-500/30 bg-rose-500/15 text-rose-600 dark:text-rose-400"
          title="Account is locked"
        />
      )}

      {/* Self-exclusion (responsible-gambling) — a restricted state exactly
          like ban/lock, so it belongs in this strip. ACTIVE = rose (the user
          is CURRENTLY blocked from betting/withdrawing on the game platform).
          EXPIRED = amber (the flag is still set but the window lapsed — useful
          context, not an active restriction). USER-initiated + DISPLAY-ONLY. */}
      {selfExclusion === "active" && (
        <FlagChip
          icon={ShieldBan}
          label="Self-Excluded"
          className="border-rose-500/30 bg-rose-500/15 text-rose-600 dark:text-rose-400"
          title="User self-excluded (responsible gambling) — currently restricted on the game platform"
        />
      )}
      {selfExclusion === "expired" && (
        <FlagChip
          icon={ShieldBan}
          label="Self-Excl. expired"
          className="border-amber-500/30 bg-amber-500/15 text-amber-600 dark:text-amber-400"
          title="Self-exclusion window has lapsed — no longer restricted (flag still set on the account)"
        />
      )}

      {/* Unclaimed vouchers — the user is holding voucher value (a card
          equivalent / house liability per CLAUDE.md). Only when > 0. */}
      {vouchersValue > 0 && (
        <FlagChip
          icon={Ticket}
          label={`Vouchers ${formatCurrency(vouchersValue)}`}
          className="border-rose-500/30 bg-rose-500/15 text-rose-600 dark:text-rose-400"
          title="User holds unclaimed voucher value (counts against Platform P&L)"
        />
      )}
      {/* Wager requirement is intentionally NOT surfaced here — the
          dedicated "Wager Left" KPI tile in the hero already shows the
          remaining requirement (met / $X left / exempt), so a duplicate
          flag chip would be redundant. */}
    </div>
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
    <div className="sticky top-[3.25rem] z-20 rounded-xl border bg-card/80 p-1 backdrop-blur-md">
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
  // Flat KPI tile: neutral bg-card surface + hairline border, completely
  // static (no hover shadow, no sheen). h-full + w-full so the tile still
  // fills its equal-width grid cell (the grid owns sizing). The accent
  // survives only on the icon + the value number — House-POV tint for
  // money/P&L, the informational hue for the rest. Kept compact so the
  // dense hero KPI grid still fits beside the identity column.
  return (
    <div className="h-full w-full min-w-0 rounded-lg border bg-card px-2.5 py-2">
      <div className="flex items-center gap-1.5">
        <Icon className={cn("size-3 shrink-0", colors.icon)} />
        <span className="truncate text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          {label}
        </span>
      </div>
      <p
        className={cn(
          "mt-1 truncate text-sm font-bold tracking-tight tabular-nums leading-tight sm:text-base",
          colors.text,
        )}
      >
        {value}
      </p>
      {sub && (
        <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
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
