import { Suspense } from "react";
import { notFound } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, ArrowLeft } from "lucide-react";
import {
  getUserTransactions,
  getUserInventory,
  getUserRewards,
} from "@/lib/queries/users";
import {
  getUserDetailCached,
  getUserPnlBreakdownCached,
  getRiskScoreCached,
  getUserHeaderCritical,
} from "@/lib/queries/users-detail-cache";
import { getNotesForUser } from "@/lib/queries/admin-notes";
import { getUserTags } from "@/lib/queries/user-tags";
import { getUserCreatorHistory } from "@/lib/queries/user-role-history";
import { requirePageAccess, getUserPermissions } from "@/lib/dal";
import { hasCapability } from "@/app/(admin)/settings/roles/permissions-utils";
import { ensureSupportBaseline } from "@/lib/support-baseline";
import { UserTagsPanel } from "./user-tags-panel";
import { AutoRefresh } from "../../dashboard/auto-refresh";
import {
  getSharedIpUsers,
  getSharedFingerprintUsers,
} from "@/lib/fraud/shared-identity";
import { UserViewModern } from "./user-view-modern";
import { coerceTab } from "./user-tabs-types";
import type { TabKey } from "./user-tabs-types";
import { safeQuery, safeQueryOrNull } from "@/lib/errors/safe-query";
import {
  getUserWagerRequirement,
  type UserWagerRequirement,
} from "@/lib/backend-api/wager-requirements";
import { Skeleton } from "@/components/ui/skeleton";
import {
  KpiStripSkeleton,
  TabBarSkeleton,
} from "@/components/loading-skeletons";

export const metadata = { title: "User Detail" };

// The heavy per-user detail fetches in this route segment inherit this
// function time budget. 300s is Vercel's default cap and gives the detail
// aggregate + Platform-P&L breakdown comfortable headroom on prod-sized data.
// Page reads remain bounded by their own per-query safeQuery timeouts.
export const maxDuration = 300;

// Per-query wall-clock bound for the heavy detail fetches. Long enough that
// a healthy query on prod-sized data finishes well inside it, short enough
// that a pathological scan (e.g. an unbounded ledger join) degrades to a
// fallback tile instead of hanging the streamed band until the platform
// kills the request. Matches the reward-insights default (REWARD_QUERY_TIMEOUT_MS).
const USER_DETAIL_QUERY_TIMEOUT_MS = 15_000;

// GAMING is pack / battle / upgrader play — entry, payout, refund.
// Sale / exchange rows live in FINANCIAL_TYPES below so card sales
// appear alongside deposits and withdrawals as cash-movement events;
// the gaming tab stays focused on gameplay.
const GAMING_TYPES = [
  "pack_opening",
  "battle_bet",
  "battle_sponsorship",
  "battle_refund",
  "upgrader_bet",
  "upgrader_payout",
  "voucher_redeemed",
];
// FINANCIAL covers deposits, withdrawals, and direct cash payouts
// (rakeback / affiliate / rain / race / gift / promo). Card sales +
// card / voucher exchanges intentionally live in NEITHER tab — they
// bloated the Deposits & Withdrawals view with rows admins did not
// consider cash events. If a future surface needs them they'll get
// their own section instead of being folded into Financial.
const FINANCIAL_TYPES = [
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
];
// Admin balance adjustments get a DEDICATED, generously-sized fetch on top of
// the shared FINANCIAL page. Reason: `admin_balance_adjustment` is just one of
// the 12 FINANCIAL_TYPES above, so on an active account a burst of newer
// deposits/withdrawals/claims fills the shared 10-row page and pushes an older
// adjustment off page 1 entirely — making it vanish from the Overview feed.
// Pulling adjustments separately (rare admin events; ADJ_LIMIT covers a user's
// lifetime) guarantees EVERY adjustment reaches the Overview timeline + the
// dedicated block. Same query path, so the official_stream fake-balance
// exclusion still applies automatically.
const ADJUSTMENT_TYPES = ["admin_balance_adjustment"];
const ADJ_LIMIT = 200;

export default async function UserDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  // Self-heal support's /users baseline before the gate runs — same
  // protection as /users/page.tsx so a deep-link into /users/[id]
  // also re-grants if the bulk role editor wiped it. See
  // src/lib/support-baseline.ts.
  await ensureSupportBaseline();
  const session = await requirePageAccess("/users");
  const { id } = await params;
  const sp = await searchParams;
  // Active tab is URL-driven (?tab=<key>) so deep-links from elsewhere
  // (hero risk badges, future bookmarks) still resolve correctly.
  // The shell hydrates this into client state on mount so subsequent
  // tab clicks are instant — see UserViewModern.
  const initialTab = coerceTab(sp.tab);

  // ── CRITICAL PATH — keep it tiny so first paint is instant ─────────
  //
  // The bug this guards against: the page used to BLOCK its entire first
  // paint on a single `Promise.all([...])` of ~14 queries — getUserDetail
  // (~19 Main-DB round-trips + the canonical P&L helper), two inventory
  // pages, the P&L breakdown, the risk-score aggregate, rewards, and the
  // tab transactions. A SINGLE slow/failing query among them threw a
  // promise that propagated to the segment error.tsx and replaced the
  // WHOLE page with "Couldn't load this user". Mirrors the /creators/[userId]
  // fix (commit 27d35c0): await only a cheap header on the critical path,
  // then stream the heavy body in its own Suspense boundary.
  //
  // getUserHeader is two indexed identity reads — username/email for the
  // back-link header. This is the page's ONE un-streamed critical-path
  // read, so historically it was also the LAST way the page could hard-
  // crash to the segment error boundary: if the Postgres pool was
  // momentarily starved by a couple of runaway per-user scans (the
  // failure db.ts documents), even this cheap read could block until the
  // platform tore the request down → "Couldn't load this user" (digest
  // 497656675). getUserHeaderCritical bounds it with a short wall-clock
  // budget and degrades instead of throwing: a clean null is still the
  // ONLY 404 path (genuinely unknown id), but a timeout/failure yields an
  // id-only placeholder header so the shell renders and the streamed body
  // (its own timeout-wrapped getUserDetail) fills in the real identity.
  const headerResult = await getUserHeaderCritical(id);
  if (!headerResult.found) notFound();
  const header = headerResult.header;

  // Permissions for the union-capability checks. For admins this is a
  // constant (no query); for non-admins it's a single cache()'d admin-DB
  // read that `requirePageAccess("/users")` above ALREADY resolved for this
  // request, so reading it here is free (memoized) — NOT one of the heavy
  // Main-DB queries that crash the page. Resolved on the critical path so
  // the tag panel keeps its real manage-capability (a CRM role with
  // __can_manage_user_tags must stay able to edit tags), and passed down to
  // the streamed body so its capability gating uses the same value.
  const permissions =
    session.role === "admin"
      ? null
      : await getUserPermissions(session.userId);

  // Tag management is independent of the per-action capabilities so it can
  // be granted to a CRM/sales role without giving them ban/edit-identity/
  // wipe etc.
  const canManageUserTags =
    session.role === "admin" ||
    hasCapability(permissions ?? [], "__can_manage_user_tags");

  // VIP tags (admin-CRM metadata) back the dashed tag-panel row that sits
  // with the header. Cheap admin-DB read, but still safeQuery-wrapped so a
  // transient admin-DB hiccup renders the empty-state row rather than
  // taking down the header.
  const { data: userTags } = await safeQuery(
    () => getUserTags(id),
    [],
    "users.detail.tags",
  );

  return (
    <div className="space-y-4">
      {/* Re-fetch server data every 60s so admins watching a user-detail
          tab don't see stale gaming transactions / balances. router.refresh
          re-runs the page-level fetches and re-renders the whole tree, so
          the active tab's tables update in place without changing tab. */}
      <AutoRefresh intervalMs={60_000} />
      <div className="space-y-2">
        <div className="flex items-center gap-3 flex-wrap">
          <Link href="/users" className="inline-flex size-9 items-center justify-center rounded-md hover:bg-accent hover:text-accent-foreground">
            <ArrowLeft className="size-4" />
          </Link>
          <div className="min-w-0">
            <h1 className="text-2xl font-bold leading-tight">
              {/* On a degraded (timed-out) identity read username + email
                  are both null — show a short id so the header still reads
                  as a real user; the streamed body resolves the full
                  identity in its own hero. */}
              {header.username ?? header.email ?? `User ${header.id.slice(0, 8)}`}
            </h1>
            <p className="text-sm text-muted-foreground">
              {header.email ?? (
                <span className="font-mono">{header.id.slice(0, 12)}…</span>
              )}
            </p>
          </div>
        </div>
        {/* VIP tag manager — dedicated dashed-border row so admins
            always notice the section (even on empty profiles). Read-
            only for viewers without __can_manage_user_tags. */}
        <UserTagsPanel
          userId={id}
          initialTags={userTags}
          canManage={canManageUserTags}
        />
      </div>

      {/* ── STREAMED HEAVY BODY ─────────────────────────────────────────
          The hero KPI strip + tabbed content (balances, P&L, inventory,
          gaming/financial transactions, rewards, trust) all live in
          UserViewModern, which needs the heavy getUserDetail aggregate +
          ~half a dozen other Main-DB reads. Streaming it behind its own
          Suspense keeps those reads off the header's TTFB, and every fetch
          inside is timeout-wrapped (safeQuery) so a slow/failed one shows a
          fallback section instead of throwing the whole page. ─────────── */}
      <Suspense fallback={<UserDetailBodySkeleton />}>
        <UserDetailBody
          id={id}
          sessionRole={session.role}
          permissions={permissions}
          initialTab={initialTab}
        />
      </Suspense>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────
//  STREAMED BODY — owns the heavy getUserDetail aggregate + the rest of
//  the per-tab data. Rendered behind its own Suspense from the page so
//  those reads never extend the header's TTFB. Every heavy fetch is
//  timeout-bounded (safeQuery) so a slow scan degrades to a fallback
//  shape the downstream components already tolerate, rather than hanging
//  the band; getUserDetail failing surfaces a compact degraded banner
//  for this band (the header above already rendered) instead of a 404.
// ───────────────────────────────────────────────────────────────────
async function UserDetailBody({
  id,
  sessionRole,
  permissions,
  initialTab,
}: {
  id: string;
  sessionRole: string;
  // Union permission keys for non-admin viewers (null for admins), resolved
  // on the critical path and threaded down so capability gating matches the
  // tag panel's and avoids a second (cache()'d, but clearer-as-prop) read.
  permissions: string[] | null;
  initialTab: TabKey;
}) {
  // Empty paginated-transaction shape used as the safeQuery fallback for
  // the gaming + financial tx fetches below. Same shape
  // `getUserTransactions` already returns for users with zero matching
  // ledger rows, so the downstream CategoryTransactionsTable +
  // RecentActivityTimeline render a normal empty-state instead of
  // crashing on undefined access. When an upstream DB hiccup (e.g. a
  // transient join failure on the upgrader_games / battle_participants
  // relations) would otherwise blank the whole user-detail page — the
  // Gaming tab in particular was reportedly unclickable because a thrown
  // promise here propagated up to the segment error boundary and
  // replaced the tab bar with the error page.
  const EMPTY_TX_PAGE = {
    data: [],
    total: 0,
    page: 1,
    perPage: 10,
    totalPages: 0,
  };
  // Empty paginated-inventory shape — same shape getUserInventory returns
  // for a user with no matching rows, so InventoryTab renders its normal
  // empty-state grid instead of crashing on undefined access.
  const EMPTY_INVENTORY_PAGE = {
    data: [],
    total: 0,
    page: 1,
    perPage: 24,
    totalPages: 0,
  };
  // Zeroed P&L breakdown — every field the Platform-P&L panels read, set to
  // 0 so the panels render a neutral "no realized P&L" state on failure
  // rather than throwing. Mirrors the all-zero shape getUserPnlBreakdown
  // already returns for a user with no ledger activity.
  const EMPTY_PNL = {
    packRevenue: 0,
    battleRevenue: 0,
    upgraderRevenue: 0,
    cardSalesPayouts: 0,
    gamblingPnlRealized: 0,
    unrealizedLiability: 0,
    gamblingPnlTrue: 0,
    bonusesCost: 0,
    rakebackCost: 0,
    affiliateCost: 0,
    otherCosts: 0,
    otherCostsDetail: {
      rainWin: 0,
      racePrize: 0,
      balanceRewardClaim: 0,
      creatorTip: 0,
      voucherRedeemed: 0,
      voucherExchange: 0,
      exchangeExcessCredit: 0,
      exchangeExcessToVoucher: 0,
      battleExcessToVoucher: 0,
      affiliateLeaderboard: 0,
    },
    netPnlRealized: 0,
    netPnlTrue: 0,
    pnl12h: 0,
    pnl24h: 0,
    pnl3d: 0,
    pnl7d: 0,
    pnl14d: 0,
    deposits24h: 0,
    deposits3d: 0,
    deposits7d: 0,
    deposits14d: 0,
  };

  // ── CRITICAL BODY GROUP ────────────────────────────────────────────
  //
  // Everything the identity hero + the default Overview tab need to paint:
  // the heavy detail aggregate, the P&L breakdown, owned inventory, the
  // gaming + financial tx pages, notes, rewards, creator history, and the
  // risk score (the hero badges read riskBreakdown.score / .tier /
  // .sharedIpCount, so it MUST resolve before first paint). This group
  // gates the body Suspense.
  //
  // The three NON-CRITICAL reads — disposed inventory, shared-IP users and
  // shared-fingerprint users — are NOT awaited here. They only feed the
  // Inventory tab's "Sold & Exchanged" table and the Trust tab, neither of
  // which renders until the operator clicks that tab. Awaiting them in this
  // Promise.all used to make the WHOLE body (including Overview) wait on
  // their network/identity fan-out. They're kicked off below as their own
  // in-flight promises and streamed into those tabs behind a second,
  // non-blocking Suspense — same queries, same args, same return shapes,
  // just no longer on the first-paint critical path. See UserViewModern.
  const [
    detailResult,
    inventoryResult,
    pnlResult,
    notesResult,
    rewardsResult,
    creatorHistoryResult,
    riskResult,
  ] = await Promise.all([
    // getUserDetail is THE heavy aggregate (~19 Main-DB round-trips + the
    // canonical calculateUserPnl helper). Previously it ran un-wrapped in
    // the page's Promise.all, so any failure/timeout in it crashed the
    // whole page. Now it's timeout-bounded and null-on-failure → the body
    // renders a compact degraded banner (the header already painted).
    // Cached cross-request (60s) so the AutoRefresh tick + "Try again"
    // resolve from the warmed entry instead of re-paying the full scan.
    safeQueryOrNull(
      () => getUserDetailCached(id),
      "users.detail.detail",
      USER_DETAIL_QUERY_TIMEOUT_MS,
    ),
    // Owned inventory page (critical — backs the Inventory tab's current
    // grid + drives the hero inventory value). Was un-wrapped before, so a
    // slow user_inventory scan blanked the page. Degrade to an empty page.
    safeQuery(
      () => getUserInventory(id, 1, 24, { status: "owned" }),
      EMPTY_INVENTORY_PAGE,
      "users.detail.inventory",
      USER_DETAIL_QUERY_TIMEOUT_MS,
    ),
    // Platform-P&L breakdown — multiple ledger aggregates + the 5-window
    // rolling-P&L scan (the heaviest read on the page on an unindexed DB).
    // Un-wrapped before; degrade to the all-zero shape. Cached
    // cross-request (60s) so refresh/retry skip the rescan.
    safeQuery(
      () => getUserPnlBreakdownCached(id),
      EMPTY_PNL,
      "users.detail.pnl",
      USER_DETAIL_QUERY_TIMEOUT_MS,
    ),
    // Admin notes (admin-DB). Cheap, but wrap it so an admin-DB hiccup
    // doesn't blank the page — the Account tab renders its empty notes
    // state instead.
    safeQuery(() => getNotesForUser(id), [], "users.detail.notes"),
    // Rewards summary (one_time reward count + rakeback claimable/claimed).
    // Un-wrapped before; degrade to the zeroed summary so the Rewards tab
    // renders its empty state.
    safeQuery(
      () => getUserRewards(id),
      { openOneTimeCount: 0, rakebackClaimableUsd: 0, rakebackClaimedUsd: 0 },
      "users.detail.rewards",
      USER_DETAIL_QUERY_TIMEOUT_MS,
    ),
    // Creator history already self-degrades inside the query (its own
    // try/catch returns the empty shape). safeQuery adds the central
    // log line on top so the failure surfaces in Vercel logs with the
    // standard `[error:users.detail.creatorHistory]` prefix.
    safeQuery(
      () => getUserCreatorHistory(id),
      { everCreatorByAudit: false, creatorSince: null },
      "users.detail.creatorHistory",
    ),
    // Fraud / trust assessment for the hero badges + Trust tab.
    // Heavy cross-table aggregate + network/timeline fan-out. Failure →
    // the hero falls back to the same neutral "low / 0 / no signals"
    // shape the query itself emits for unknown users, so the risk
    // badge renders unobtrusively instead of blanking the whole view.
    // Cached cross-request (60s) on top of the score module's own
    // in-process memo so a cold function instance / "Try again" skips
    // the rescan.
    safeQuery(
      () => getRiskScoreCached(id),
      {
        score: 0,
        tier: "low" as const,
        signals: [],
        topReasons: [],
        suggestions: [],
        timeline: [],
        sharedIpCount: 0,
        sharedFingerprintCount: 0,
        sharedBannedCount: 0,
        sharedLockedCount: 0,
        computedAt: Date.now(),
        computeDurationMs: 0,
      },
      "users.detail.riskScore",
      USER_DETAIL_QUERY_TIMEOUT_MS,
    ),
  ]);

  // ── NON-CRITICAL STREAMED GROUP ────────────────────────────────────
  //
  // Kicked off here but deliberately NOT awaited — gaming + financial tx
  // (plus the dedicated adjustments page) and the tab-gated disposed
  // inventory + Trust shared-identity reads. Each promise resolves to the
  // SAME bare data shape the critical reads used to produce (safeQuery
  // result unwrapped via `.data`). UserViewModern `use()`s them inside
  // Suspense boundaries scoped to the sections/tabs that need them so the
  // hero + balance panels paint without waiting on ledger enrichment.
  const gamingTxPromise = safeQuery(
    () => getUserTransactions(id, 1, 10, { types: GAMING_TYPES }),
    EMPTY_TX_PAGE,
    "users.detail.gamingTx",
    USER_DETAIL_QUERY_TIMEOUT_MS,
  ).then((r) => r.data);
  const financialTxPromise = safeQuery(
    () => getUserTransactions(id, 1, 10, { types: FINANCIAL_TYPES }),
    EMPTY_TX_PAGE,
    "users.detail.financialTx",
    USER_DETAIL_QUERY_TIMEOUT_MS,
  ).then((r) => r.data);
  const adjustmentsTxPromise = safeQuery(
    () => getUserTransactions(id, 1, ADJ_LIMIT, { types: ADJUSTMENT_TYPES }),
    EMPTY_TX_PAGE,
    "users.detail.adjustmentsTx",
    USER_DETAIL_QUERY_TIMEOUT_MS,
  ).then((r) => r.data);
  const disposedInventoryPromise = safeQuery(
    () => getUserInventory(id, 1, 24, { status: "disposed" }),
    EMPTY_INVENTORY_PAGE,
    "users.detail.disposedInventory",
    USER_DETAIL_QUERY_TIMEOUT_MS,
  ).then((r) => r.data);
  // Fingerprints / shared-IP tables may be absent in fresh/dev
  // environments — degrade gracefully to an empty list rather than
  // crashing the user detail page.
  const sharedIpsPromise = safeQuery(
    () => getSharedIpUsers(id),
    [],
    "users.detail.sharedIps",
  ).then((r) => r.data);
  const sharedFingerprintsPromise = safeQuery(
    () => getSharedFingerprintUsers(id),
    [],
    "users.detail.sharedFingerprints",
  ).then((r) => r.data);

  // Per-user withdrawal wager-requirement override (backend API, NOT the
  // MAIN DB). Read NON-critically in its own try/catch — deliberately kept
  // OUT of the heavy getUserDetailCached aggregate above so a backend
  // outage / undeployed branch can never block or crash the user-detail
  // body. null → the Account-tab card shows its muted "awaiting backend
  // deploy" state.
  let wagerRequirement: UserWagerRequirement | null = null;
  try {
    wagerRequirement = await getUserWagerRequirement(id);
  } catch {
    wagerRequirement = null;
  }

  const data = detailResult.data;

  // getUserDetail returns null only for a truly unknown user — but the
  // header already resolved via getUserHeader, so a null here means the
  // aggregate read failed/timed out. Surface a compact degraded state for
  // this band rather than 404-ing the whole (already-rendered) page.
  if (!data) {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
        <AlertTriangle className="size-4 mt-0.5 text-amber-500 shrink-0" />
        <div>
          <div className="font-medium text-amber-500">
            User details are taking too long to load
          </div>
          <div className="mt-0.5 text-muted-foreground">
            The balances, P&amp;L, and activity for this user timed out or
            failed against the main DB. Refresh to retry — the header above
            is unaffected.
          </div>
        </div>
      </div>
    );
  }

  const creatorHistory = creatorHistoryResult.data;
  const riskBreakdown = riskResult.data;
  const inventory = inventoryResult.data;
  const pnlBreakdown = pnlResult.data;
  const notes = notesResult.data;
  const rewards = rewardsResult.data;

  // "Ever a creator?" = currently creator, OR an audit role-change to
  // creator exists, OR they own affiliate codes (created only for
  // creators). wasCreator surfaces the past-creator badge for users who
  // aren't creators right now.
  const everCreator =
    data.user.role === "creator" ||
    creatorHistory.everCreatorByAudit ||
    data.user.ownedCodes.length > 0;
  const wasCreator = everCreator && data.user.role !== "creator";

  const capabilities =
    sessionRole === "admin"
      ? {
          canAdjustBalance: true,
          canAdjustXp: true,
          canEditIdentity: true,
          canBanUsers: true,
          canLockUsers: true,
          canToggleFeatureLocks: true,
          canAssignAffiliate: true,
          canChangeUserRoles: true,
          canRecordManualWithdrawal: true,
        }
      : {
          canAdjustBalance: hasCapability(permissions ?? [], "__can_adjust_balance"),
          canAdjustXp: hasCapability(permissions ?? [], "__can_adjust_xp"),
          canEditIdentity: hasCapability(permissions ?? [], "__can_edit_identity"),
          canBanUsers: hasCapability(permissions ?? [], "__can_ban_users"),
          canLockUsers: hasCapability(permissions ?? [], "__can_lock_users"),
          canToggleFeatureLocks: hasCapability(permissions ?? [], "__can_toggle_feature_locks"),
          canAssignAffiliate: hasCapability(permissions ?? [], "__can_assign_affiliate"),
          canChangeUserRoles: hasCapability(permissions ?? [], "__can_change_user_roles"),
          canRecordManualWithdrawal: hasCapability(permissions ?? [], "__can_record_manual_withdrawal"),
        };

  const detailWithSession = {
    ...data,
    sessionRole,
    capabilities,
    wasCreator,
    creatorSince: creatorHistory.creatorSince,
  };

  return (
    <UserViewModern
      data={detailWithSession}
      gamingTxPromise={gamingTxPromise}
      financialTxPromise={financialTxPromise}
      adjustmentsTxPromise={adjustmentsTxPromise}
      rewards={rewards}
      notes={notes}
      pnlBreakdown={pnlBreakdown}
      inventory={inventory}
      disposedInventoryPromise={disposedInventoryPromise}
      riskBreakdown={riskBreakdown}
      sharedIpsPromise={sharedIpsPromise}
      sharedFingerprintsPromise={sharedFingerprintsPromise}
      wagerRequirement={wagerRequirement}
      initialTab={initialTab}
    />
  );
}

// ── Suspense fallback ────────────────────────────────────────────────
//
// Matches the heavy body's shape (UserViewModern's identity hero + KPI
// strip + tab bar + tab content) so the swap-in is jank-free. Same shape
// the route-level loading.tsx renders for the full page.
function UserDetailBodySkeleton() {
  return (
    <div className="space-y-6">
      {/* Modern user view: identity hero with avatar + status pills + KPIs.
          8 KPI tiles + 8 tabs — counts mirror UserViewModern's hero strip
          and tab bar so the streamed body swaps in without a layout jump. */}
      <Skeleton className="h-32 rounded-2xl" />
      <KpiStripSkeleton count={8} />
      <TabBarSkeleton count={8} />
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <Skeleton className="h-48 rounded-2xl" />
        <Skeleton className="h-48 rounded-2xl" />
        <Skeleton className="h-48 rounded-2xl" />
      </div>
      <Skeleton className="h-64 rounded-2xl" />
    </div>
  );
}
