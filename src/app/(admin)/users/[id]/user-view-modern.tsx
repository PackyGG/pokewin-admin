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
} from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { usePathname, useRouter } from "next/navigation";
import {
  Swords,
  Gem,
  Gift,
  ShieldCheck,
  Activity,
  Sparkles,
  Calendar,
  MapPin,
  Megaphone,
  Ban,
  Lock,
  Ticket,
  ShieldBan,
  BadgeCheck,
  Fingerprint,
  Network,
  ScrollText,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils/format";
import { RelativeTime } from "@/components/relative-time";
import {
  IP_CLUSTER_SUSPICIOUS_MAX,
  ROLE_COLORS,
  USER_STATUS_COLORS,
} from "@/lib/constants";
import {
  type UserDetail,
  type PaginatedTransactions,
  type PnlBreakdown,
} from "./user-tabs";
import type { UserRewards } from "@/lib/queries/users";
import type { PaginatedInventory } from "./user-tabs-types";
import type { UserWagerRequirement } from "@/lib/backend-api/wager-requirements";
import type { UserFeatureLocks } from "@/lib/backend-api/feature-locks";
import type { FiatDepositAccess } from "@/lib/backend-api/fiat-deposit-access";
import type { FiatEligibilityOverride } from "@/lib/antifraud/fiat-eligibility-overrides-api";
import type { UserKycStatus } from "@/lib/backend-api/kyc";
import type { UserWagerProgress } from "@/lib/queries/users-wager-progress";
import type { UserBalanceWeighting } from "@/lib/queries/users-balance-weighting";
import type { UserRewardPackOpensResult } from "@/lib/queries/users-reward-pack-opens";
import type { SafeQueryResult } from "@/lib/errors/safe-query";
import {
  OverviewTab,
  RewardsTab,
  GamingTab,
  InventoryTab,
  AccountTab,
  KycTab,
} from "./user-view-modern-tabs";
import type { UserAdminAuditFeed } from "@/lib/queries/users-admin-audit";
import { FadeIn } from "@/components/fade-in";
import { DURATION, SkeletonTable } from "@/components/ux";
import {
  ChangeRoleDialog,
  ResetRoleToUserButton,
} from "./user-tabs-dialogs";
import { UserAdminActions } from "./user-tabs-moderation";
import { UserHeroSticky } from "./user-hero-sticky";
import { CopyButton } from "@/components/copy-button";
import { FingerprintAltDialog } from "../fingerprint-alt-dialog";

// ---------------------------------------------------------------------------
// Deferred tab chunk. The Audit tab pulls the whole admin-audit vocabulary
// (`admin-users/[id]/audit-events-table` — label/color maps + the
// `EventDetails` renderer) plus its own table/select primitives, yet the tab
// only mounts when `?tab=audit` is active. `user-tabs-audit` is imported
// NOWHERE else, so code-splitting it here genuinely removes that chunk from
// the /users/[id] critical bundle for every other tab. SSR is left ON so the
// server-rendered markup is byte-identical to before — only the client chunk
// is fetched lazily. Mirrors the `transaction-detail-modal` split in
// user-tabs-transactions.tsx.
//
// NOTE (intentionally NOT split): `ChangeRoleDialog` / `ResetRoleToUserButton`
// live in `./user-tabs-dialogs`, which is already a static dependency of both
// `./user-view-modern-panels` (re-exported below) and
// `./user-view-modern-tabs`. Lazy-loading them from here would add a loading
// state without removing a single byte from the bundle.
// ---------------------------------------------------------------------------
const AuditTab = dynamic(
  () => import("./user-tabs-audit").then((m) => m.AuditTab),
  {
    loading: () => (
      <div className="space-y-4">
        <SkeletonTable rows={8} columns={5} leadingAvatar={false} />
      </div>
    ),
  },
);

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
  KycTab,
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
  // KYC (Sumsub) identity verification — split out of the Account tab into its
  // own tab so the verification status + Require/Review controls get a
  // dedicated surface. The read is Active-Timeframe-Only (page.tsx kicks it
  // only when ?tab=kyc is active).
  { key: "kyc", label: "KYC", icon: BadgeCheck },
  // Audit — the admin action trail against THIS account (who banned/locked
  // /adjusted them, why, and when). Same Active-Timeframe-Only contract:
  // page.tsx kicks the admin-DB read only when ?tab=audit is active.
  { key: "audit", label: "Audit", icon: ScrollText },
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
  inventoryPromise,
  disposedInventoryPromise,
  wagerRequirementPromise,
  featureLocksPromise,
  fiatDepositAccessPromise,
  preFiatOverridePromise,
  kycPromise,
  auditPromise,
  wagerProgressPromise,
  balanceWeightingPromise,
  viewerIsAdjustmentOwner,
  viewerCanSeeUltraLossback,
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
  // Inventory tab:
  inventoryPromise: Promise<SafeQueryResult<PaginatedInventory>> | null;
  disposedInventoryPromise: Promise<SafeQueryResult<PaginatedInventory>> | null;
  // Account tab — per-user withdrawal wager-requirement override (backend
  // API, NOT the MAIN DB; plain nullable value, its own catch→null wrapper
  // in page.tsx). null resolution = the card's muted degraded state.
  wagerRequirementPromise: Promise<UserWagerRequirement | null> | null;
  // Account tab — backend-owned fraud-signal deposit/withdrawal locks
  // (card refund/chargeback). Same catch→null convention as the
  // wager-requirement override above.
  featureLocksPromise: Promise<UserFeatureLocks | null> | null;
  // Account tab — backend-owned per-user Fiat deposit allow-list access.
  // Independent from fraud/compliance locks; null is a visible degraded state.
  fiatDepositAccessPromise: Promise<FiatDepositAccess | null> | null;
  preFiatOverridePromise: Promise<FiatEligibilityOverride | null> | null;
  // Account tab — backend-owned Sumsub KYC status + admin control. Same
  // catch→null convention as the fraud-locks read above.
  kycPromise: Promise<UserKycStatus | null> | null;
  // Audit tab — admin-DB action trail targeting this user (who banned/locked
  // them and why). Full SafeQueryResult so the band can show a visible error
  // instead of a silent empty log.
  auditPromise: Promise<SafeQueryResult<UserAdminAuditFeed>> | null;
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
  viewerCanSeeUltraLossback: boolean;
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

  // Unclaimed voucher value — surfaced as a House-liability flag chip in the
  // hero utility strip (HeroFlagsStrip). The hero's KPI display tiles (Total
  // Value, P&L, Wager Left, Multiplier, House Edge) were removed per owner
  // 2026-07-12; those figures live on the Overview tab (Balances / Platform-
  // P&L panels) and the Account tab (wager cards).
  const vouchersValue = balances?.vouchersValue ?? 0;

  const displayName =
    user.displayUsername ?? user.username ?? user.name ?? "—";

  // ── Meta line items — country / joined / short id / 2FA / affiliate /
  // ex-creator. Demoted from colored badges to ONE quiet uniform muted line
  // (owner 2026-07-12 hero redesign): each is an inline-flex chip with a
  // size-3 lucide icon, and only 2FA-OFF carries a mild amber security tint.
  // The affiliate + ex-creator entries are conditional, so the row is built
  // as an array and dot-separated at render time (no leading/trailing/double
  // dots regardless of which entries are present).
  const metaItems: { key: string; node: React.ReactNode }[] = [
    {
      key: "country",
      node: (
        <span className="inline-flex items-center gap-1">
          <MapPin className="size-3" />
          {user.country ?? user.countryCode ?? "Unknown"}
        </span>
      ),
    },
    {
      key: "joined",
      node: (
        <span className="inline-flex items-center gap-1">
          <Calendar className="size-3" />
          <RelativeTime date={user.createdAt} />
        </span>
      ),
    },
    {
      // User ID — short form shown, FULL id copied.
      key: "id",
      node: (
        <span
          className="inline-flex items-center gap-1 font-mono"
          title={user.id}
        >
          {user.id.slice(0, 8)}
          <CopyButton value={user.id} label="User ID" />
        </span>
      ),
    },
    {
      // 2FA state — muted when ON, a mild amber tint when OFF (a real, low
      // grade security signal). No badge fill either way.
      key: "2fa",
      node: (
        <span
          className={cn(
            "inline-flex items-center gap-1",
            !user.twoFactorEnabled && "text-amber-600 dark:text-amber-500",
          )}
        >
          <ShieldCheck className="size-3" />
          2FA {user.twoFactorEnabled ? "on" : "off"}
        </span>
      ),
    },
  ];
  if (user.affiliateCode) {
    metaItems.push({
      key: "affiliate",
      node: (
        <span className="inline-flex items-center gap-1">
          <Ticket className="size-3" />
          {user.affiliateCode}
        </span>
      ),
    });
  }
  if (data.wasCreator) {
    metaItems.push({
      // Ex-creator — not a creator now but was one before (audit role-change
      // to creator, or own creator-only affiliate codes). Muted text; the
      // full context stays in the hover tooltip.
      key: "ex-creator",
      node: (
        <span
          title={
            data.creatorSince
              ? `Previously had the creator role — creator since ${data.creatorSince.slice(0, 10)}`
              : "Previously had the creator role"
          }
        >
          Ex-creator
        </span>
      ),
    });
  }

  // ── HERO ──────────────────────────────────────────────────────────
  // Extracted as a node so UserHeroSticky can render it inline AND derive
  // a thin condensed bar (avatar + name + balance) that appears once the
  // hero scrolls out of view. The tab bar's own sticky behaviour is
  // untouched (the condensed bar layers above it on z-index).
  //
  // Layout (owner 2026-07-12 "redesign it properly" pass) — a FLAT card
  // (solid bg-card + hairline border + one soft shadow; no gradient, no
  // corner-glow) with a clear LEFT identity / RIGHT action-cluster split and
  // a strict THREE-TIER text hierarchy so nothing wraps at the same visual
  // weight anymore:
  //   LEFT  = backSlot + avatar (+ status dot) + text column:
  //             tier 1 name line  → name + copy + role/status/alert badges
  //                                  (the ONLY colored badges in the hero)
  //             tier 2 email line → email + verified ✓ + copy (muted)
  //             tier 3 meta line  → country · joined · id · 2FA · affiliate ·
  //                                  ex-creator — ONE calm greyscale line
  //   RIGHT = creator-page link + site-role group + admin actions + tags,
  //           uniformly sm-sized, top-aligned with the name line
  //           (outer row is lg:items-start).
  // On <lg the RIGHT cluster wraps below the identity block; the name always
  // truncates so the badges stay visible at every width.
  const heroNode = (
    <div className="rounded-xl border bg-card shadow-sm">
      <div className="flex flex-col gap-4 p-4 lg:flex-row lg:items-start lg:justify-between lg:gap-6">
        {/* ── LEFT — identity block ─────────────────────────────────── */}
        <div className="flex min-w-0 flex-1 items-start gap-4">
          {/* Compact back-to-users button — tucked left of the avatar. */}
          {backSlot}
          <div className="relative shrink-0">
            {/* Prominent avatar — anchors the identity block. */}
            <Avatar className="size-14 sm:size-16 ring-2 ring-background shadow-sm">
              {user.image && <AvatarImage src={user.image} alt="" />}
              <AvatarFallback className="text-base font-semibold">
                {(user.username ?? user.email ?? "?").slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <span
              className={cn(
                "absolute -bottom-0.5 -right-0.5 size-4 rounded-full border-2 border-background",
                statusKey === "active" && "bg-emerald-500",
                statusKey === "locked" && "bg-amber-500",
                statusKey === "banned" && "bg-rose-500",
              )}
              aria-label={statusLabel}
            />
          </div>

          {/* Text column — three tiers (name / email / meta). */}
          <div className="min-w-0 flex-1 space-y-1">
            {/* Tier 1 — name + copy + the colored signal badges (site role,
                moderation status, and the real alert chips). These are the
                ONLY colored badges in the whole hero. The name truncates so
                the shrink-0 badges always stay visible. */}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h2 className="min-w-0 truncate text-lg font-bold leading-tight sm:text-xl">
                {displayName}
              </h2>
              <CopyButton value={displayName} label="Username" />
              <Badge
                variant="outline"
                className={cn(
                  "h-5 shrink-0 py-0 text-[10px]",
                  ROLE_COLORS[user.role] ?? "",
                )}
              >
                {user.role}
              </Badge>
              <Badge
                variant="outline"
                className={cn(
                  "h-5 shrink-0 py-0 text-[10px]",
                  USER_STATUS_COLORS[statusKey] ?? "",
                )}
              >
                {statusLabel}
              </Badge>
              {/* Real ALERT chips (banned / locked / self-excluded / held
                  vouchers) — genuine warnings, so they KEEP color and belong
                  grouped with the status badge. Collapses to nothing for a
                  clean user (display:contents strip). */}
              <HeroFlagsStrip
                userId={user.id}
                statusKey={statusKey}
                selfExclusion={selfExclusion}
                vouchersValue={vouchersValue}
                suspectedAlt={user.suspectedAlt}
                linkedDeviceAccountCount={user.linkedDeviceAccountCount}
                deviceCaptureCount={user.deviceCaptureCount}
                deviceCapturedAt={user.deviceCapturedAt}
                deviceConfidence={user.deviceConfidence}
                deviceVisitorId={user.deviceVisitorId}
                deviceVisitorIdCount={user.deviceVisitorIdCount}
                deviceSignupCaptureCount={user.deviceSignupCaptureCount}
                deviceLoginCaptureCount={user.deviceLoginCaptureCount}
                deviceLastLoginAt={user.deviceLastLoginAt}
                deviceLastLoginIp={user.deviceLastLoginIp}
                deviceLastLoginVisitorId={user.deviceLastLoginVisitorId}
                signupIpSharedCount={user.signupIpSharedCount}
              />
            </div>

            {/* Tier 2 — email (muted) + verified ✓ + copy. */}
            <div className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground">
              <span className="truncate">{user.email}</span>
              {user.emailVerified && (
                <span className="shrink-0 text-xs font-semibold text-emerald-500">
                  ✓
                </span>
              )}
              {user.email && <CopyButton value={user.email} label="Email" />}
            </div>

            {/* Tier 3 — meta line: one calm greyscale row of quiet facts,
                dot-separated. No colored badge confetti. */}
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
              {metaItems.map((item, i) => (
                <React.Fragment key={item.key}>
                  {i > 0 && (
                    <span aria-hidden className="text-muted-foreground/40">
                      ·
                    </span>
                  )}
                  {item.node}
                </React.Fragment>
              ))}
            </div>
          </div>
        </div>

        {/* ── RIGHT — action cluster ────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-1.5 lg:shrink-0 lg:justify-end">
          {/* Quick-link to the creator detail page — only for on-site
              creators (the /creators/<id> route shares the main-site user id
              space). One accented nav button is acceptable. */}
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
          {/* Site-role controls — change the user's role on the game platform
              (user / creator / support / admin), NOT admin-panel access.
              Rendered inline as plain buttons (no wrapping box/label) so they
              match the size of the other action-cluster buttons. */}
          {canChangeUserRoles && (
            <>
              <ChangeRoleDialog userId={user.id} currentRole={user.role} />
              {/* Quick escape hatch when /creators backend demote gets stuck —
                  only renders for current creators. */}
              <ResetRoleToUserButton userId={user.id} currentRole={user.role} />
            </>
          )}
          <UserAdminActions
            user={user}
            isAdmin={isAdmin}
            capabilities={capabilities}
          />
          {/* VIP tags dropdown — pre-rendered in page.tsx and threaded in as
              a serializable ReactNode. */}
          {tagsSlot}
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
            viewerCanSeeUltraLossback={viewerCanSeeUltraLossback}
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
          />
        )}

        {activeTab === "account" && (
          <AccountTab
            data={data}
            pnlResultPromise={pnlResultPromise}
            wagerRequirementPromise={wagerRequirementPromise}
            featureLocksPromise={featureLocksPromise}
            fiatDepositAccessPromise={fiatDepositAccessPromise}
            preFiatOverridePromise={preFiatOverridePromise}
            wagerProgressPromise={wagerProgressPromise}
            balanceWeightingPromise={balanceWeightingPromise}
            adjustmentsTxPromise={adjustmentsTxPromise}
            viewerIsAdjustmentOwner={viewerIsAdjustmentOwner}
            viewerCanSeeUltraLossback={viewerCanSeeUltraLossback}
          />
        )}

        {activeTab === "kyc" && (
          <KycTab data={data} kycPromise={kycPromise} canManage={isAdmin} />
        )}

        {activeTab === "audit" && (
          <AuditTab data={data} auditPromise={auditPromise} />
        )}
      </FadeIn>
    </div>
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
  userId,
  statusKey,
  selfExclusion,
  vouchersValue,
  suspectedAlt,
  linkedDeviceAccountCount,
  deviceCaptureCount,
  deviceCapturedAt,
  deviceConfidence,
  deviceVisitorId,
  deviceVisitorIdCount,
  deviceSignupCaptureCount,
  deviceLoginCaptureCount,
  deviceLastLoginAt,
  deviceLastLoginIp,
  deviceLastLoginVisitorId,
  signupIpSharedCount,
}: {
  userId: string;
  statusKey: "active" | "locked" | "banned";
  selfExclusion: SelfExclusionState;
  vouchersValue: number;
  /** Device-fingerprint alt-account signal (fingerprints.suspected_alt_triggered). */
  suspectedAlt: boolean;
  /** Other accounts sharing any of this user's device visitor_ids. */
  linkedDeviceAccountCount: number;
  /** Fingerprint rows for this user. 0 = capture never happened. */
  deviceCaptureCount: number;
  /** Most recent capture (ISO), null when never captured. */
  deviceCapturedAt: string | null;
  /** Best confidence across captures (0–1), null when never captured. */
  deviceConfidence: number | null;
  /** visitor_id of the most recent capture — the actual device identifier. */
  deviceVisitorId: string | null;
  /** Distinct visitor_ids for this user (>1 = seen on multiple devices). */
  deviceVisitorIdCount: number;
  deviceSignupCaptureCount: number;
  deviceLoginCaptureCount: number;
  deviceLastLoginAt: string | null;
  deviceLastLoginIp: string | null;
  deviceLastLoginVisitorId: string | null;
  /** Other accounts sharing this user's signup IP. 0 = unique to them. */
  signupIpSharedCount: number;
}) {
  return (
    // `display: contents` — the strip owns no box of its own; its chips
    // become direct flex items of the parent utility chip row, sharing that
    // row's gap / wrap / alignment so everything reads as ONE dense line.
    // Renders nothing visible for a clean user (all conditions false).
    <div className="contents">
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
      {/* Device-fingerprint alt-account flag — the platform's own signup/
          login fingerprinting heuristic. Rose (a real fraud-review signal,
          same weight as banned/locked). The linked-device count (other
          accounts sharing a device with this one) rides in the tooltip
          rather than its own chip — it's supporting detail for this flag,
          not a separate independent signal. */}
      {(() => {
        // ALWAYS rendered — unlike the chips above, the device signal shows
        // in all three states. "Never captured" is itself worth seeing: a
        // silent capture failure (missing cookie, blocked agent, a stale
        // frontend build) is otherwise indistinguishable from a clean user,
        // which is exactly how a multi-hour outage went unnoticed.
        const capturedLabel =
          deviceCapturedAt
            ? `${deviceCapturedAt.replace("T", " ").slice(0, 16)} UTC`
            : "unknown time";
        const confidenceLabel =
          deviceConfidence === null
            ? ""
            : ` at ${Math.round(deviceConfidence * 100)}% confidence`;
        const sharedLabel =
          linkedDeviceAccountCount > 0
            ? ` ${linkedDeviceAccountCount} other account${linkedDeviceAccountCount === 1 ? "" : "s"} share a device with this one.`
            : "";
        const devicesLabel =
          deviceVisitorIdCount > 1
            ? ` Seen on ${deviceVisitorIdCount} distinct devices.`
            : "";
        const captureBreakdown =
          ` Signup captures: ${deviceSignupCaptureCount}. Login captures: ${deviceLoginCaptureCount}.`;
        const loginLabel = deviceLoginCaptureCount > 0
          ? ` Latest verified login: ${deviceLastLoginAt?.replace("T", " ").slice(0, 16) ?? "unknown time"} UTC${deviceLastLoginIp ? ` from ${deviceLastLoginIp}` : ""}${deviceLastLoginVisitorId ? ` on ${deviceLastLoginVisitorId}` : ""}.`
          : " No verified login fingerprint has been captured yet.";
        // FULL visitor_id here, unlike the /users list which truncates to fit
        // a table cell. The detail page has the room, and a truncated
        // identifier can't be matched against the DB or a log line by eye —
        // which is the whole reason to surface it.
        const idLabel = deviceVisitorId;
        const idTitle = deviceVisitorId
          ? `Device ID (FingerprintJS visitor_id): ${deviceVisitorId}`
          : "";

        // Rose — a real fraud-review signal, same weight as banned/locked.
        if (suspectedAlt) {
          return (
            <FingerprintAltDialog
              sourceUserId={userId}
              className="inline-flex h-5 items-center gap-0.5 rounded-md border border-rose-500/30 bg-rose-500/15 px-2 py-0 font-mono text-[10px] font-medium text-rose-600 outline-none hover:bg-rose-500/25 focus-visible:ring-2 focus-visible:ring-ring dark:text-rose-400"
              title={`Suspected alt — device fingerprinting flagged this account at signup/login.${sharedLabel}${devicesLabel}${captureBreakdown}${loginLabel}\n${idTitle}`}
            >
              <Fingerprint className="size-2.5" />
              {idLabel ? `Alt · ${idLabel}` : "Suspected Alt"}
            </FingerprintAltDialog>
          );
        }

        // Amber — coverage gap, NOT an accusation. No fingerprint row means
        // we never identified this device, so alt-detection can't work here.
        if (deviceCaptureCount === 0) {
          return (
            <FlagChip
              icon={Fingerprint}
              label="No device ID"
              className="border-amber-500/30 bg-amber-500/15 text-amber-600 dark:text-amber-400"
              title={`No device fingerprint was captured for this account — alt-detection cannot evaluate it.${captureBreakdown}${loginLabel}`}
            />
          );
        }

        // Muted — captured and clean. Informational, so it must not compete
        // with the genuine warning chips beside it.
        return (
          <FingerprintAltDialog
            sourceUserId={userId}
            className="inline-flex h-5 items-center gap-0.5 rounded-md border border-border/60 bg-muted/50 px-2 py-0 font-mono text-[10px] font-medium text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
            title={`${idTitle}\nCaptured ${capturedLabel}${confidenceLabel}. No alt flag.${sharedLabel}${devicesLabel}${captureBreakdown}${loginLabel}`}
          >
            <Fingerprint className="size-2.5" />
            {idLabel ?? "Device ID"}
          </FingerprintAltDialog>
        );
      })()}
      {/* Shared signup IP. Amber ONLY for a small cluster — that band is
          where sharing is actually worth investigating. Bigger clusters are
          CGNAT / VPN exits / office NAT (nine IPs on prod carry ~1,490 users
          between them), so they render muted and informational. Never rose:
          rose belongs to the device fingerprint, which is the high-confidence
          signal, and a second red would flatten that distinction. */}
      {signupIpSharedCount > 0 && (
        <FlagChip
          icon={Network}
          label={`IP ×${signupIpSharedCount}`}
          className={
            signupIpSharedCount <= IP_CLUSTER_SUSPICIOUS_MAX
              ? "border-amber-500/30 bg-amber-500/15 text-amber-600 dark:text-amber-400"
              : "border-border/60 bg-muted/50 text-muted-foreground"
          }
          title={
            signupIpSharedCount <= IP_CLUSTER_SUSPICIOUS_MAX
              ? `Signup IP shared with ${signupIpSharedCount} other account${signupIpSharedCount === 1 ? "" : "s"} — a cluster this small is worth a look`
              : `Signup IP shared with ${signupIpSharedCount} other accounts — a cluster this large is almost always CGNAT, a VPN exit or office NAT, not alts`
          }
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
