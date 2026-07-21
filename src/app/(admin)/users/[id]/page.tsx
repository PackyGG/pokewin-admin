import { Suspense, type ReactNode } from "react";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import {
  getUserTransactions,
  getUserInventory,
  getUserRewards,
  EMPTY_USER_REWARDS,
} from "@/lib/queries/users";
import {
  getUserDetailCached,
  getUserPnlBreakdownCached,
  getUserGamingTransactionsCached,
  getUserFinancialTransactionsCached,
  resolveUserIdCritical,
} from "@/lib/queries/users-detail-cache";
import { getUserTags } from "@/lib/queries/user-tags";
import { getUserCreatorHistory } from "@/lib/queries/user-role-history";
import { requirePageAccess, getUserPermissions } from "@/lib/dal";
import { hasCapability } from "@/app/(admin)/settings/roles/permissions-utils";
import { canEditBalanceAdjustments } from "@/lib/balance-adjustment-edit/motha-gate";
import { isAdjustmentVisibilityOwner } from "@/lib/users/owner-adjustments-visibility";
import { ensureSupportBaseline } from "@/lib/support-baseline";
import { UserTagsPanel } from "./user-tags-panel";
import { AutoRefresh } from "../../dashboard/auto-refresh";
import { UserViewModern } from "./user-view-modern";
import { coerceTab } from "./user-tabs-types";
import type { TabKey } from "./user-tabs-types";
import {
  safeQuery,
  safeQueryOrNull,
  type SafeQueryResult,
} from "@/lib/errors/safe-query";
import { getUserWagerRequirement } from "@/lib/backend-api/wager-requirements";
import { getUserFeatureLocks } from "@/lib/backend-api/feature-locks";
import { getUserKyc } from "@/lib/backend-api/kyc";
import { getUserWagerProgress } from "@/lib/queries/users-wager-progress";
import { getUserBalanceWeighting } from "@/lib/queries/users-balance-weighting";
import { getUserRewardPackOpens } from "@/lib/queries/users-reward-pack-opens";
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

// GAMING is the full pack / battle / upgrader play cycle: the BET legs
// (entry / sponsorship) AND the in-game WIN legs (battle_refund, upgrader
// payout). The item cash-OUTS (card_sale / reward_card_sale / voucher_redeemed)
// and the battle_excess_to_voucher win-grant were moved to the INVENTORY tab
// per owner — they realize/grant a held item (voucher == card per house rules),
// so they sit with the inventory they came from. battle_excess_to_voucher in
// particular was redundant on Gaming: the paired battle_bet row already shows
// the full win P&L. Keep this list in sync with GAMING_TX_TYPES in
// user-tabs-types.ts (this = initial 10-row fetch; that = load-more).
// Pure exchanges (card_exchange / voucher_exchange / exchange_excess_*) are
// NOT here — exchanging an item is value-neutral, not a realization.
const GAMING_TYPES = [
  "pack_opening",
  "battle_bet",
  "battle_sponsorship",
  "battle_refund",
  "upgrader_bet",
  "upgrader_payout",
  // card_sale / reward_card_sale (selling a won/reward card back to cash) AND
  // voucher_redeemed (cashing a won voucher back to balance) are inventory /
  // item cash-OUTS — they live on the INVENTORY tab now (CARD_SALE_TX_TYPES),
  // shown next to the items they came from. Owner moved them out of Gaming so
  // this tab stays the bet/play + win surface.
  // battle_excess_to_voucher ALSO moved to the INVENTORY tab
  // (BATTLE_VOUCHER_TYPES) per owner: the paired battle_bet row already shows
  // the full win P&L here, so the separate voucher-leg row was redundant on
  // Gaming. It's a voucher GRANT (a held item, voucher == card), so it now
  // sits with the inventory it created.
];
// FINANCIAL covers deposits, withdrawals (card_withdrawal +
// withdrawal_shipping_fee) and direct cash payouts (rakeback / affiliate /
// rain / race / gift / promo). The win-realization rows (card_sale /
// reward_card_sale) and the battle_excess_to_voucher win-grant do NOT live
// here — they're on the INVENTORY tab (CARD_SALE_TYPES / BATTLE_VOUCHER_TYPES),
// next to the items they realize/created. Pure card / voucher exchanges
// (card_exchange / voucher_exchange / exchange_excess_*) are in NEITHER tab —
// exchanging an item is value-neutral, not a cash event.
const FINANCIAL_TYPES = [
  "deposit",
  "deposit_bonus",
  "admin_balance_adjustment",
  "card_withdrawal",
  // Cash leg of a crypto-BALANCE withdrawal (new sweepstakes model) — the user
  // cashing out, same as card_withdrawal. Keep in sync with FINANCIAL_TX_TYPES
  // in user-tabs-types.ts. Drift-safe via the LIVE-enum intersection.
  "balance_withdrawal",
  "withdrawal_shipping_fee",
  "rakeback_claim",
  "balance_reward_claim",
  "affiliate_claim",
  "promo_code_redeemed",
  "gift_card_redeemed",
  "rain_win",
  "race_prize",
  // Creator/affiliate-leaderboard win paid to the user — surfaced in the
  // Deposits & Withdrawals feed alongside race_prize (it ALSO keeps its own
  // "Leaderboard" box on Overview). Keep in sync with FINANCIAL_TX_TYPES in
  // user-tabs-types.ts. Drift-safe via the LIVE-enum intersection.
  "affiliate_leaderboard_prize",
  // Challenge prize is a direct cash payout (user completed + claimed a
  // challenge) — surface it in the Deposits & Withdrawals feed alongside the
  // other claim-shaped payouts. Drift-safe: getUserTransactions intersects
  // the requested list with the LIVE enum, so a DB without this member just
  // drops it instead of throwing 22P02.
  "challenge_prize",
  // XP purchase — the user spent withdrawable balance to buy XP (a debit /
  // house gain). Same drift-safe intersection applies. Keep in sync with
  // FINANCIAL_TX_TYPES in user-tabs-types.ts.
  "xp_purchase",
  // Vault movements — user-internal transfer between available balance and
  // the Fireblocks-locked vault product (no house P&L, but the available-
  // balance side moves, so an operator looking at a `balance_withdrawal`
  // can trace it back to the unlock that funded it). Drift-safe via the
  // LIVE-enum intersection in getUserTransactions. Keep in sync with
  // FINANCIAL_TX_TYPES in user-tabs-types.ts.
  "vault_lock",
  "vault_unlock",
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
  const { id: routeKey } = await params;
  // Route-key → user id resolution is the ONLY thing awaited before the
  // Suspense boundary below, so an UNGUARDED throw here (pool starvation /
  // transient DB error) would hit the segment error boundary and crash the
  // whole page. resolveUserIdCritical races the (now-indexed) lookup against
  // a short timeout and NEVER throws — a slow/failed resolve degrades to a
  // clean notFound() instead of a raw crash (a refresh re-runs the indexed
  // lookup and resolves). A genuinely-unknown key also returns found:false.
  const resolved = await resolveUserIdCritical(routeKey);
  if (!resolved.found) notFound();
  const id = resolved.id;
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
  // Existence / 404 is already settled above by resolveUserIdCritical: a
  // clean null (unknown key) OR a slow/failed resolve both surface as
  // found:false → notFound(), and a non-null id only for a row that exists.
  // Crucially, that guard NEVER throws, so a transient resolve failure can
  // no longer crash this (highest-traffic) route via the segment error
  // boundary — it degrades to a retry-able 404. The streamed body's hero
  // renders the identity (username/email) from its own timeout-wrapped
  // getUserDetail, so the critical path needs no second identity read. The
  // whole heavy body still streams behind its own Suspense boundary below,
  // so a slow/failed aggregate degrades that band instead of the page.

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

  // Back button is rendered here and passed as a plain React ELEMENT
  // (serializable node — NOT a function prop) down through the streamed
  // body into the hero. It needs nothing async, so it stays on the
  // critical path; the VIP tag manager (an admin-DB read) is built INSIDE
  // the streamed body instead, keeping that read off first paint. The
  // back button is a compact icon tucked into the hero's top-left.
  const backSlot = (
    <Link
      href="/users"
      aria-label="Back to users"
      className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border bg-card/60 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
    >
      <ArrowLeft className="size-4" />
    </Link>
  );

  return (
    <div className="space-y-4">
      {/* Re-fetch server data every 60s so admins watching a user-detail
          tab don't see stale gaming transactions / balances. router.refresh
          re-runs the page-level fetches and re-renders the whole tree, so
          the active tab's tables update in place without changing tab. */}
      <AutoRefresh intervalMs={60_000} />

      {/* ── STREAMED HEAVY BODY ─────────────────────────────────────────
          The hero KPI strip + tabbed content (balances, P&L, inventory,
          gaming/financial transactions, rewards) all live in
          UserViewModern, which needs the heavy getUserDetail aggregate +
          ~half a dozen other Main-DB reads. Streaming it behind its own
          Suspense keeps those reads off the header's TTFB, and every fetch
          inside is timeout-wrapped (safeQuery) so a slow/failed one shows a
          fallback section instead of throwing the whole page. The back
          button (resolved above) is threaded in as a serializable React
          element; the tag manager is built inside the body from its own
          parallel admin-DB read so both render inside the hero. ──── */}
      <Suspense fallback={<UserDetailBodySkeleton />}>
        <UserDetailBody
          id={id}
          sessionRole={session.role}
          sessionUserId={session.userId}
          permissions={permissions}
          initialTab={initialTab}
          backSlot={backSlot}
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
  backSlot,
}: {
  id: string;
  sessionRole: string;
  sessionUserId: string;
  // Union permission keys for non-admin viewers (null for admins), resolved
  // on the critical path and threaded down so capability gating matches the
  // tag panel's and avoids a second (cache()'d, but clearer-as-prop) read.
  permissions: string[] | null;
  initialTab: TabKey;
  // Pre-rendered React element (serializable node, NOT a function prop)
  // resolved on the critical path in the page above: the compact back-to-
  // users button. The VIP tag manager (tagsSlot) is built HERE in the
  // streamed body from a tab-independent admin-DB read kicked alongside the
  // body gate, so its read never extends the shell's first paint.
  backSlot: ReactNode;
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
  // adjacent Overview panels AND the Account tab's windowed strips.
  // 60s-cached cross-request, timeout-bounded.
  const pnlResultPromise = safeQuery(
    () => getUserPnlBreakdownCached(id),
    EMPTY_PNL,
    "users.detail.pnl",
    USER_DETAIL_QUERY_TIMEOUT_MS,
  );

  const wantsGamingTx = initialTab === "overview" || initialTab === "gaming";
  // Overview's "Deposits & Withdrawals" feed. The standalone Finances tab was
  // removed (folded away), so this is now Overview-only.
  const wantsFinancialTx = initialTab === "overview";

  const gamingTxPromise = wantsGamingTx
    ? safeQuery(
        // Gaming tab defaults to 25 rows; the Overview tab's compact gaming
        // preview keeps the smaller 10-row page. Prod-only cached (15s,
        // viewer-independent — gaming types carry no owner-gated adjustment
        // rows) so the 60s AutoRefresh tick + retries + revisits skip the
        // heavy ledger+enrichment fan-out. See getUserGamingTransactionsCached.
        () =>
          getUserGamingTransactionsCached(
            id,
            1,
            initialTab === "gaming" ? 25 : 10,
            GAMING_TYPES,
          ),
        EMPTY_TX_PAGE,
        "users.detail.gamingTx",
        USER_DETAIL_QUERY_TIMEOUT_MS,
      )
    : null;
  // Overview deposits & withdrawals feed. Prod-only cached (30s) keyed on the
  // resolved owner flag — the type set includes the owner-gated admin_balance_adjustment
  // rows, so the cache key carries `ownerRes.data` AND it's passed as the
  // viewerIsOwnerOverride (the live session read can't run inside the cache).
  // Chained on the fast owner probe, NOT the heavy body gate. Non-owners (the
  // common case) get instant cached repeats; the owner's entry is separate and
  // includes adjustments. See getUserFinancialTransactionsCached.
  const financialTxPromise: Promise<SafeQueryResult<UserTxPage>> | null =
    wantsFinancialTx
      ? viewerIsOwnerPromise.then((ownerRes) =>
          safeQuery(
            () =>
              getUserFinancialTransactionsCached(
                id,
                1,
                10,
                FINANCIAL_TYPES,
                ownerRes.data,
              ),
            EMPTY_TX_PAGE,
            "users.detail.financialTx",
            USER_DETAIL_QUERY_TIMEOUT_MS,
          ),
        )
      : null;
  // Adjustments: Account-tab-only (moved off Overview — the dedicated
  // admin-balance-adjustments block now lives on the Account tab). Kicked
  // only when the viewer is the owner `motha` — a non-owner gets a resolved
  // empty page instead of a wasted round trip (the server returns zero
  // adjustment rows for them anyway; the fail-closed gate inside
  // getUserTransactions remains the security authority, this skip is purely a
  // perf nicety). Chained on the owner probe (fast admin-DB read), NOT on the
  // heavy body gate.
  const adjustmentsTxPromise: Promise<SafeQueryResult<UserTxPage>> | null =
    initialTab === "account"
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
          EMPTY_USER_REWARDS,
          "users.detail.rewards",
          USER_DETAIL_QUERY_TIMEOUT_MS,
        )
      : null;
  // Rewards tab: reward / sign-up pack opens (welcome pack, level packs,
  // daily/free packs) and the cards each granted. A reward pack is an
  // inventory GIVEAWAY with no ledger grant row, so this is the only place the
  // "where did these cards come from" trail is visible. Active-Timeframe-Only:
  // kicked ONLY when the Rewards tab is the active tab.
  const rewardPackOpensPromise =
    initialTab === "rewards"
      ? safeQuery(
          () => getUserRewardPackOpens(id),
          { totalOpens: 0, totalCards: 0, totalValue: 0, opens: [] },
          "users.detail.rewardPackOpens",
          USER_DETAIL_QUERY_TIMEOUT_MS,
        )
      : null;

  // Account tab: the backend-API wager-requirement override. Keeps its own
  // catch→null wrapper (null → the card's muted "awaiting backend deploy"
  // state) — just kicked instead of serially awaited.
  const wagerRequirementPromise =
    initialTab === "account"
      ? getUserWagerRequirement(id).catch(() => null)
      : null;
  // Account tab: backend-owned fraud-signal deposit/withdrawal locks
  // (refund/chargeback). Same catch→null convention as the wager-requirement
  // override above — null renders the card's muted "awaiting backend
  // deploy" state instead of crashing the tab.
  const featureLocksPromise =
    initialTab === "account"
      ? getUserFeatureLocks(id).catch(() => null)
      : null;
  // KYC tab: backend-owned Sumsub KYC status + admin control. Same
  // catch→null convention as the fraud-locks read above — null renders the
  // card's muted "awaiting backend deploy" state instead of crashing the tab.
  // Split out of the Account tab into its own tab, so it's kicked only when
  // ?tab=kyc is active (Active-Timeframe-Only).
  const kycPromise =
    initialTab === "kyc" ? getUserKyc(id).catch(() => null) : null;
  // Account tab: how each part of the user's balance is weighted toward each
  // destination (withdrawal / races / rakeback / shards) — the funding-source
  // wager-weight matrix projected onto their balance composition. Account-tab
  // only (Active-Timeframe-Only); timeout-wrapped → muted card on slow/missing.
  const balanceWeightingPromise =
    initialTab === "account"
      ? safeQueryOrNull(
          () => getUserBalanceWeighting(id),
          "users.detail.balanceWeighting",
          USER_DETAIL_QUERY_TIMEOUT_MS,
        ).then((r) => r.data)
      : null;
  // Wager-requirement PROGRESS from the backend-written `balances` columns.
  // ALWAYS kicked (not tab-gated): the hero shows a "Wager Left" KPI on every
  // user view, and the Account tab renders the full per-source breakdown —
  // both share this one promise. Timeout-wrapped → muted/null on slow/missing.
  const wagerProgressPromise = safeQueryOrNull(
    () => getUserWagerProgress(id),
    "users.detail.wagerProgress",
    USER_DETAIL_QUERY_TIMEOUT_MS,
  ).then((r) => r.data);

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
    userTagsResult,
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
    // VIP tags (admin-CRM metadata) backing the tag manager inside the
    // hero. Moved off the page's critical path to here so its admin-DB
    // read runs in parallel with the heavy body gate (always faster than
    // getUserDetail) and never extends the shell's first paint. safeQuery-
    // wrapped: a transient admin-DB hiccup renders the empty-state row
    // rather than taking down the streamed band.
    safeQuery(() => getUserTags(id), [], "users.detail.tags"),
  ]);

  const data = detailResult.data;

  // getUserDetail returns null only for a truly unknown user — but
  // existence was already confirmed on the critical path by
  // resolveUserIdFromRouteKey, so a null here means the aggregate read
  // failed/timed out. ACCEPTED LIMITATION (stated per the
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

  // Tag management is independent of the per-action capabilities so it can
  // be granted to a CRM/sales role without giving them ban/edit-identity/
  // wipe etc. Built here (not on the critical path) and passed as a plain
  // React ELEMENT (serializable node — NOT a function prop) into the hero.
  const canManageUserTags =
    sessionRole === "admin" ||
    hasCapability(permissions ?? [], "__can_manage_user_tags");
  const tagsSlot = (
    <UserTagsPanel
      userId={id}
      initialTags={userTagsResult.data}
      canManage={canManageUserTags}
    />
  );

  return (
    <UserViewModern
      data={detailWithSession}
      backSlot={backSlot}
      tagsSlot={tagsSlot}
      pnlResultPromise={pnlResultPromise}
      gamingTxPromise={gamingTxPromise}
      financialTxPromise={financialTxPromise}
      adjustmentsTxPromise={adjustmentsTxPromise}
      rewardsPromise={rewardsPromise}
      rewardPackOpensPromise={rewardPackOpensPromise}
      inventoryPromise={inventoryPromise}
      disposedInventoryPromise={disposedInventoryPromise}
      wagerRequirementPromise={wagerRequirementPromise}
      featureLocksPromise={featureLocksPromise}
      kycPromise={kycPromise}
      wagerProgressPromise={wagerProgressPromise}
      balanceWeightingPromise={balanceWeightingPromise}
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
          8 KPI tiles + 5 tabs — counts mirror UserViewModern's hero strip
          and tab bar so the streamed body swaps in without a layout jump. */}
      <Skeleton className="h-32 rounded-2xl" />
      <KpiStripSkeleton count={8} />
      <TabBarSkeleton count={5} />
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <Skeleton className="h-48 rounded-2xl" />
        <Skeleton className="h-48 rounded-2xl" />
        <Skeleton className="h-48 rounded-2xl" />
      </div>
      <Skeleton className="h-64 rounded-2xl" />
    </div>
  );
}
