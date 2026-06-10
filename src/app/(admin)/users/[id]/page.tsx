import { Suspense } from "react";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
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
import { canEditBalanceAdjustments } from "@/lib/balance-adjustment-edit/motha-gate";
import { isAdjustmentVisibilityOwner } from "@/lib/users/owner-adjustments-visibility";
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
import {
  safeQuery,
  safeQueryOrNull,
  type SafeQueryResult,
} from "@/lib/errors/safe-query";
import { getUserWagerRequirement } from "@/lib/backend-api/wager-requirements";
import { InlineError } from "@/components/entity-surface/inline-error";
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
  // Active tab is URL-driven (?tab=<key>): the URL is the source of truth
  // for WHICH tab's queries get kicked in UserDetailBody (Active-Timeframe-
  // Only — hidden tabs are never preloaded). Tab clicks in the client shell
  // flip the pill instantly AND router.replace the new ?tab=, so this
  // server component re-renders and kicks exactly the new tab's reads.
  // Deep-links and back/forward resolve correctly by construction.
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
          sessionUserId={session.userId}
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
  sessionUserId,
  permissions,
  initialTab,
}: {
  id: string;
  sessionRole: string;
  sessionUserId: string;
  // Union permission keys for non-admin viewers (null for admins), resolved
  // on the critical path and threaded down so capability gating matches the
  // tag panel's and avoids a second (cache()'d, but clearer-as-prop) read.
  permissions: string[] | null;
  initialTab: TabKey;
}) {
  // Empty paginated-transaction shape used as the safeQuery fallback for
  // the gaming / financial / adjustments tx fetches below. Same shape
  // `getUserTransactions` already returns for users with zero matching
  // ledger rows. NOTE (reliability remake): the fallback now travels WITH
  // its `error` string inside a SafeQueryResult — the tables render a
  // visible InlineError instead of mistaking the fallback for a genuinely
  // empty history.
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
    wager24h: 0,
    wager3d: 0,
    wager7d: 0,
    wager14d: 0,
  };
  // Neutral risk shape used ONLY as the safeQuery fallback carrier — the
  // hero/Trust tab branch on the result's `error` BEFORE reading it, so a
  // failed scan renders an amber "Risk —" pill / band error, never this
  // shape as a false "low risk" all-clear.
  const EMPTY_RISK = {
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
  };

  type UserTxPage = Awaited<ReturnType<typeof getUserTransactions>>;

  // ── KICKED, NOT AWAITED — full-result band promises ────────────────
  //
  // Every band promise below resolves to a WHOLE SafeQueryResult
  // ({ data, error }) — nothing unwraps `.then(r => r.data)` anymore, so
  // the client bands can distinguish real data / genuine empty / VISIBLE
  // error (the silent-empty failure mode this remake kills). safeQuery
  // never rejects, so the `use()` sites need no client error boundaries.
  //
  // Active-Timeframe-Only: each promise is kicked ONLY when the active
  // (?tab=) tab needs it — `null` means "not kicked"; the band renders its
  // skeleton and the URL-driven tab switch re-renders this server
  // component with the new tab, which kicks it. A deep-link to
  // ?tab=account therefore never pays the gaming worth-sweep, and a 60s
  // AutoRefresh tick re-runs only the visible tab's bounded reads.

  // Owner gate — kicked FIRST so the adjustments kick below can chain on
  // it without waiting for the heavy body gate. Fail-closed false; also
  // awaited in the body gate (same promise instance, no double read).
  const viewerIsOwnerPromise = safeQuery(
    () => isAdjustmentVisibilityOwner(sessionUserId),
    false,
    "users.detail.mothaGate",
  );

  // Always kicked (tab-independent): the P&L breakdown feeds the hero-
  // adjacent Overview panels AND the Account tab's windowed strips; the
  // risk scan feeds the hero badge + Trust tab. Both 60s-cached
  // cross-request, both timeout-bounded.
  const pnlResultPromise = safeQuery(
    () => getUserPnlBreakdownCached(id),
    EMPTY_PNL,
    "users.detail.pnl",
    USER_DETAIL_QUERY_TIMEOUT_MS,
  );
  const riskResultPromise = safeQuery(
    () => getRiskScoreCached(id),
    EMPTY_RISK,
    "users.detail.riskScore",
    USER_DETAIL_QUERY_TIMEOUT_MS,
  );

  const wantsGamingTx = initialTab === "overview" || initialTab === "gaming";
  const wantsFinancialTx =
    initialTab === "overview" || initialTab === "finances";

  const gamingTxPromise = wantsGamingTx
    ? safeQuery(
        () => getUserTransactions(id, 1, 10, { types: GAMING_TYPES }),
        EMPTY_TX_PAGE,
        "users.detail.gamingTx",
        USER_DETAIL_QUERY_TIMEOUT_MS,
      )
    : null;
  const financialTxPromise = wantsFinancialTx
    ? safeQuery(
        () => getUserTransactions(id, 1, 10, { types: FINANCIAL_TYPES }),
        EMPTY_TX_PAGE,
        "users.detail.financialTx",
        USER_DETAIL_QUERY_TIMEOUT_MS,
      )
    : null;
  // Adjustments: Overview-only. Kicked only when the viewer is the owner
  // `motha` — a non-owner gets a resolved empty page instead of a wasted
  // round trip (the server returns zero adjustment rows for them anyway;
  // the fail-closed gate inside getUserTransactions remains the security
  // authority, this skip is purely a perf nicety). Chained on the owner
  // probe (fast admin-DB read), NOT on the heavy body gate.
  const adjustmentsTxPromise: Promise<SafeQueryResult<UserTxPage>> | null =
    initialTab === "overview"
      ? viewerIsOwnerPromise.then((ownerRes) =>
          ownerRes.data
            ? safeQuery(
                () =>
                  getUserTransactions(id, 1, ADJ_LIMIT, {
                    types: ADJUSTMENT_TYPES,
                  }),
                EMPTY_TX_PAGE,
                "users.detail.adjustmentsTx",
                USER_DETAIL_QUERY_TIMEOUT_MS,
              )
            : { data: EMPTY_TX_PAGE, error: null },
        )
      : null;

  // Inventory tab: owned grid page + disposed "Sold & Exchanged" page.
  // The hero's inventory/voucher VALUES come from `balances` inside the
  // detail aggregate (userPnl components), so gating these on the tab
  // costs the hero nothing.
  const inventoryPromise =
    initialTab === "inventory"
      ? safeQuery(
          () => getUserInventory(id, 1, 24, { status: "owned" }),
          EMPTY_INVENTORY_PAGE,
          "users.detail.inventory",
          USER_DETAIL_QUERY_TIMEOUT_MS,
        )
      : null;
  const disposedInventoryPromise =
    initialTab === "inventory"
      ? safeQuery(
          () => getUserInventory(id, 1, 24, { status: "disposed" }),
          EMPTY_INVENTORY_PAGE,
          "users.detail.disposedInventory",
          USER_DETAIL_QUERY_TIMEOUT_MS,
        )
      : null;

  // Rewards tab: one_time reward count + rakeback claimable/claimed.
  const rewardsPromise =
    initialTab === "rewards"
      ? safeQuery(
          () => getUserRewards(id),
          {
            openOneTimeCount: 0,
            rakebackClaimableUsd: 0,
            rakebackClaimedUsd: 0,
          },
          "users.detail.rewards",
          USER_DETAIL_QUERY_TIMEOUT_MS,
        )
      : null;

  // Account tab: admin notes (admin-DB, cheap) + the backend-API
  // wager-requirement override. The latter keeps its own catch→null
  // wrapper (null → the card's muted "awaiting backend deploy" state) —
  // just kicked instead of serially awaited.
  const notesPromise =
    initialTab === "account"
      ? safeQuery(() => getNotesForUser(id), [], "users.detail.notes")
      : null;
  const wagerRequirementPromise =
    initialTab === "account"
      ? getUserWagerRequirement(id).catch(() => null)
      : null;

  // Trust tab: shared-identity fan-outs. Previously these rode only the
  // 30s statement_timeout — now they get the same explicit per-query
  // wall-clock bound as every other band read.
  const sharedIpsPromise =
    initialTab === "trust"
      ? safeQuery(
          () => getSharedIpUsers(id),
          [],
          "users.detail.sharedIps",
          USER_DETAIL_QUERY_TIMEOUT_MS,
        )
      : null;
  const sharedFingerprintsPromise =
    initialTab === "trust"
      ? safeQuery(
          () => getSharedFingerprintUsers(id),
          [],
          "users.detail.sharedFingerprints",
          USER_DETAIL_QUERY_TIMEOUT_MS,
        )
      : null;

  // ── AWAITED BODY GATE ──────────────────────────────────────────────
  //
  // Only what EVERYTHING in UserViewModern needs before any band can
  // render: the detail aggregate (the page's spine — identity, balances,
  // capabilities), the cheap admin-DB creator history (hero wasCreator
  // badge), and the two motha gate flags (previously a serial tail of
  // UNWRAPPED awaits at the end of this function — the last reads that
  // could still throw the whole body to the segment error boundary; now
  // parallel + fail-closed false).
  const [
    detailResult,
    creatorHistoryResult,
    mothaCanEditResult,
    viewerIsOwnerResult,
  ] = await Promise.all([
    // getUserDetail is THE heavy aggregate (~19 Main-DB round-trips + the
    // canonical calculateUserPnl helper). Timeout-bounded and
    // null-on-failure → the body renders a visible full-band error (the
    // header already painted). Cached cross-request (60s) so the
    // AutoRefresh tick + retry resolve from the warmed entry.
    safeQueryOrNull(
      () => getUserDetailCached(id),
      "users.detail.detail",
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
    // Motha-only edit affordance — fail-closed false on any admin-DB
    // hiccup (an error can only HIDE the edit affordance, never grant it).
    safeQuery(
      () => canEditBalanceAdjustments(sessionUserId),
      false,
      "users.detail.mothaGate",
    ),
    viewerIsOwnerPromise,
  ]);

  const data = detailResult.data;

  // getUserDetail returns null only for a truly unknown user — but the
  // header already resolved via getUserHeader, so a null here means the
  // aggregate read failed/timed out. ACCEPTED LIMITATION (stated per the
  // remake plan): a null detail cannot partially render — everything in
  // UserViewModern hangs off `data.user` — so this stays a full-band
  // visible error with retry. After the Phase-1 query fixes this branch
  // is reachable only on a transient timeout/outage, not on every load.
  if (!data) {
    const timedOut =
      detailResult.error?.startsWith("Query exceeded") ?? false;
    return (
      <InlineError
        title={
          timedOut
            ? "User details are taking too long to load"
            : "User details failed to load"
        }
        hint={
          timedOut
            ? "The balances, P&L and activity aggregate exceeded its time budget against the main DB. The header above is unaffected — retry to re-run it."
            : "The balances, P&L and activity aggregate failed against the main DB. The header above is unaffected — retry to re-run it."
        }
      />
    );
  }

  const creatorHistory = creatorHistoryResult.data;

  // "Ever a creator?" = currently creator, OR an audit role-change to
  // creator exists, OR they own affiliate codes (created only for
  // creators). wasCreator surfaces the past-creator badge for users who
  // aren't creators right now.
  const everCreator =
    data.user.role === "creator" ||
    creatorHistory.everCreatorByAudit ||
    data.user.ownedCodes.length > 0;
  const wasCreator = everCreator && data.user.role !== "creator";

  const mothaCanEditAdjustments = mothaCanEditResult.data;

  // Owner-only adjustment visibility: only the owner `motha` may see admin
  // balance adjustments. The authoritative gate is server-side in
  // getUserTransactions (the adjustment rows are simply never returned for a
  // non-owner viewer). This flag is threaded into the view purely for
  // defence-in-depth UI hygiene — it hides the "admin balance adjustment"
  // option in the Finances type-filter dropdown so a non-owner isn't even
  // shown the category label (the dedicated adjustments block + recent
  // activity already self-hide because the server returns zero such rows).
  const viewerIsAdjustmentOwner = viewerIsOwnerResult.data;

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
          canEditBalanceAdjustments: mothaCanEditAdjustments,
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
          canEditBalanceAdjustments: mothaCanEditAdjustments,
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
      pnlResultPromise={pnlResultPromise}
      riskResultPromise={riskResultPromise}
      gamingTxPromise={gamingTxPromise}
      financialTxPromise={financialTxPromise}
      adjustmentsTxPromise={adjustmentsTxPromise}
      rewardsPromise={rewardsPromise}
      notesPromise={notesPromise}
      inventoryPromise={inventoryPromise}
      disposedInventoryPromise={disposedInventoryPromise}
      sharedIpsPromise={sharedIpsPromise}
      sharedFingerprintsPromise={sharedFingerprintsPromise}
      wagerRequirementPromise={wagerRequirementPromise}
      viewerIsAdjustmentOwner={viewerIsAdjustmentOwner}
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
