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
import { useMemo, useState, useEffect, use, Suspense } from "react";
import Link from "next/link";
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
  Banknote,
  Sparkles,
  Percent,
  Calendar,
  MapPin,
  Link2,
  Megaphone,
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
import { TILE_COLORS } from "./user-view-modern-panels";
import {
  OverviewTab,
  FinancesTab,
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
  { key: "rewards", label: "Rewards", icon: Gift },
  { key: "inventory", label: "Inventory", icon: Gem },
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
  gamingTx,
  financialTx,
  rewards,
  notes,
  pnlBreakdown,
  inventory,
  disposedInventoryPromise,
  riskBreakdown,
  sharedIpsPromise,
  sharedFingerprintsPromise,
  initialTab,
}: {
  data: UserDetail;
  gamingTx: PaginatedTransactions;
  financialTx: PaginatedTransactions;
  rewards: UserRewards;
  notes: AdminNote[];
  pnlBreakdown: PnlBreakdown;
  inventory: PaginatedInventory;
  // Tab-gated, non-critical reads streamed in as in-flight promises from
  // page.tsx so the hero + Overview tab paint without blocking on them.
  // They resolve to the exact same shapes the eager props used to carry;
  // each is `use()`d inside a Suspense scoped to just the tab that needs it
  // (disposed inventory → Inventory tab; shared IPs/fingerprints → Trust
  // tab), so opening that tab shows a brief skeleton instead of the whole
  // body having waited for the network/identity fan-out up front.
  disposedInventoryPromise: Promise<PaginatedInventory>;
  riskBreakdown: RiskScoreBreakdown;
  sharedIpsPromise: Promise<SharedIdentityUser[]>;
  sharedFingerprintsPromise: Promise<SharedIdentityUser[]>;
  // Initial tab seeded from the ?tab= URL param so deep-links (e.g.
  // the hero risk badges that linked to ?tab=trust, or external
  // bookmarks) still land on the correct tab. After mount the tab
  // state is client-side so subsequent switches are instant — no
  // server round-trip, no refetch.
  initialTab: TabKey;
}) {
  const { user, balances, counts, capabilities } = data;
  const isAdmin = data.sessionRole === "admin";
  const canChangeUserRoles = capabilities.canChangeUserRoles;
  const [activeTab, setActiveTab] = useState<TabKey>(initialTab);

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

        <div className="relative p-3 sm:p-5 md:p-6">
          <div className="flex flex-col gap-4 sm:gap-6 lg:flex-row lg:items-center lg:justify-between">
            {/* Identity */}
            <div className="flex items-start gap-3 sm:gap-4 min-w-0">
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
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <h2 className="text-lg sm:text-xl font-bold leading-tight truncate min-w-0">
                    {displayName}
                  </h2>
                  {user.username && user.displayUsername &&
                    user.displayUsername !== user.username && (
                      <span className="text-xs sm:text-sm text-muted-foreground truncate">
                        @{user.username}
                      </span>
                    )}
                </div>
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
                </div>
                {canChangeUserRoles && (
                  <p className="text-[11px] text-muted-foreground">
                    Role on the game platform — not admin-panel access.
                  </p>
                )}
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
                  <button
                    type="button"
                    onClick={() => setActiveTab("trust")}
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
                      onClick={() => setActiveTab("trust")}
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
                  <span className="font-mono">{user.id.slice(0, 8)}</span>
                </div>
              </div>
            </div>

            {/* KPI strip — sits to the right of the identity on wide screens,
                wraps below on narrow. Tighter tiles than before so the hero
                stays compact. Wagering metrics (Wager Loss + total
                Wagered/Won) live on the Account tab instead of cluttering
                the hero. Phone: 2 cols (3 cols was too tight at 375px),
                tablet: 4 cols, md: 6 cols (smooths the 4→7 jump on
                laptops so the last tile wraps cleanly instead of the row
                snapping width), desktop: 7 cols. The Total Depo tile sits
                directly next to P&L so the operator can read "$X
                deposited → $Y P&L" left-to-right. */}
            <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-7 gap-2 shrink-0">
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

      {/* ── TAB BAR ──────────────────────────────────────────────────
          On phone the pills horizontal-scroll instead of wrapping into
          two rows; the active tab scrolls itself into view when changed.
          Edge-fade gradients hint at scrollable content. On lg+ screens
          all 8 tabs fit naturally so no scroll needed. */}
      <ScrollableTabBar
        visibleTabs={visibleTabs}
        activeTab={activeTab}
        onChange={setActiveTab}
      />

      {/* ── TAB CONTENT ──────────────────────────────────────────────
          All data is fetched upfront in page.tsx and threaded down as
          props, so tab switches are instant client-side toggles — no
          server round-trip, no streaming wait. FadeIn keyed on the
          active tab matches the analytics-tab crossfade behaviour. */}
      <FadeIn key={activeTab} speed="fast">
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

        {activeTab === "inventory" && (
          // Owned inventory (critical `inventory` prop) paints immediately;
          // InventoryTab streams ONLY its disposed "Sold & Exchanged" table
          // behind an inner Suspense scoped to disposedInventoryPromise.
          <InventoryTab
            data={data}
            inventory={inventory}
            disposedInventoryPromise={disposedInventoryPromise}
          />
        )}

        {activeTab === "trust" && (
          // The whole Trust tab depends on the shared-identity fan-out, so
          // it streams as a unit behind its own Suspense; the risk score
          // itself is already resolved (critical — the hero badges read it).
          <Suspense fallback={<TrustTabFallback />}>
            <TrustTabStreamed
              userId={user.id}
              breakdown={riskBreakdown}
              sharedIpsPromise={sharedIpsPromise}
              sharedFingerprintsPromise={sharedFingerprintsPromise}
            />
          </Suspense>
        )}

        {activeTab === "affiliate" && <AffiliateTab data={data} />}

        {activeTab === "account" && (
          <AccountTab
            data={data}
            notes={notes}
            pnlBreakdown={pnlBreakdown}
          />
        )}
      </FadeIn>
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
//  network/identity fan-out that page.tsx now kicks off OFF the critical
//  path (see UserDetailBody). This thin client wrapper `use()`s those
//  in-flight promises and renders the unchanged <TrustTab> with the
//  resolved arrays, so the heavy read no longer blocks the hero / Overview.
//  Only mounted when the Trust tab is active, inside a <Suspense>.
// ───────────────────────────────────────────────────────────────────

function TrustTabStreamed({
  userId,
  breakdown,
  sharedIpsPromise,
  sharedFingerprintsPromise,
}: {
  userId: string;
  breakdown: RiskScoreBreakdown;
  sharedIpsPromise: Promise<SharedIdentityUser[]>;
  sharedFingerprintsPromise: Promise<SharedIdentityUser[]>;
}) {
  const sharedIps = use(sharedIpsPromise);
  const sharedFingerprints = use(sharedFingerprintsPromise);
  return (
    <TrustTab
      userId={userId}
      breakdown={breakdown}
      sharedIps={sharedIps}
      sharedFingerprints={sharedFingerprints}
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
        "group relative overflow-hidden rounded-xl border p-2.5 sm:p-3 md:p-4 transition-all hover:shadow-md min-w-0",
        colors.bg,
      )}
    >
      <div className="flex items-center gap-1.5 sm:gap-2">
        <Icon className={cn("size-3.5 sm:size-4 md:size-5 shrink-0", colors.icon)} />
        <span className="text-[10px] sm:text-[11px] md:text-xs font-semibold uppercase tracking-wider text-muted-foreground truncate">
          {label}
        </span>
      </div>
      <p
        className={cn(
          "mt-1 sm:mt-1.5 text-base sm:text-lg lg:text-xl font-bold tabular-nums leading-tight truncate",
          colors.text,
        )}
      >
        {value}
      </p>
      {sub && (
        <p className="mt-0.5 sm:mt-1 text-[10px] sm:text-[11px] text-muted-foreground truncate">
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
