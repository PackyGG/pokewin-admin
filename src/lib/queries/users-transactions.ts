import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { Prisma } from "@/generated/prisma/client";
import {
  filterLedgerTxTypes,
  filterLedgerTxTypesLive,
  isLiveLedgerTxType,
} from "./_ledger-tx-types";
import {
  fetchUpgraderTargetByLedgerTxIds,
  resolveUpgraderTargetFromBatch,
} from "./upgrader-target-batch";
import { getInstantRakebackLedgerTxIds } from "./rakeback-instant-ledger";
import { officialStreamAdjustmentPrismaWhere } from "@/lib/balance-adjustment-categories";
import { getMothaAdjustmentLedgerTxIdsForUser } from "@/lib/queries/users-motha-adjustments";
import { isMothaOnlyAdjustmentsProfile } from "@/lib/users/motha-only-adjustments-profile";
import { isAdjustmentVisibilityOwner } from "@/lib/users/owner-adjustments-visibility";
import { verifySession } from "@/lib/dal";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import type { ledger_transaction_type } from "@/generated/prisma/enums";
import type {
  Transaction,
  PaginatedTransactions,
} from "@/app/(admin)/users/[id]/user-tabs-types";

/**
 * Withdrawal-side ledger types (the user cashing out): the crypto/card
 * payout (`card_withdrawal`), the sweepstakes balance-withdrawal cash leg
 * (`balance_withdrawal`), and the physical-card shipping-fee leg
 * (`withdrawal_shipping_fee`). Mirrors `WITHDRAWAL_TX_TYPES` in
 * `users/[id]/user-tabs-types.ts` — kept LOCAL here (server query layer) so
 * the blacklist suppression below doesn't reach into the page module.
 *
 * For a BLACKLISTED user (present in `getExcludedUserIds()`) these rows —
 * and their amounts — are suppressed from every per-user transactions
 * surface (Deposits & Withdrawals feed, the Withdrawals filter segment,
 * pagination / load-more, and the transaction-detail modal, which only
 * renders rows already in the table). Consistent with the user being fully
 * hidden per owner request 2026-07-01.
 */
const BLACKLIST_HIDDEN_WITHDRAWAL_TYPES: readonly ledger_transaction_type[] = [
  "card_withdrawal",
  "balance_withdrawal",
  "withdrawal_shipping_fee",
] as ledger_transaction_type[];

/** Ledger types that pull in pack/battle/upgrader enrichment (expensive). */
const GAMING_LEDGER_TYPES = new Set<string>([
  "pack_opening",
  "battle_bet",
  "battle_sponsorship",
  "battle_refund",
  "upgrader_bet",
  "upgrader_payout",
  "voucher_redeemed",
]);

function isFinancialOnlyFilter(filters?: {
  type?: string;
  types?: string[];
}): boolean {
  if (filters?.type && filters.type !== "all") {
    return !GAMING_LEDGER_TYPES.has(filters.type);
  }
  if (filters?.types && filters.types.length > 0) {
    const valid = filterLedgerTxTypes(filters.types);
    return (
      valid.length > 0 &&
      valid.every((t) => !GAMING_LEDGER_TYPES.has(t))
    );
  }
  return false;
}

async function resolveCanonicalUserId(
  db: Awaited<ReturnType<typeof getDb>>,
  userId: string,
): Promise<string | null> {
  const user = await db.user.findFirst({
    where: {
      OR: [{ id: userId }, { id: { equals: userId, mode: "insensitive" } }],
    },
    select: { id: true },
  });
  return user?.id ?? null;
}

type LedgerRow = Awaited<
  ReturnType<
    Awaited<ReturnType<typeof getDb>>["ledger_transactions"]["findMany"]
  >
>[number];

function mapFinancialLedgerRow(t: LedgerRow, instantRakebackIds?: Set<string>) {
  const balanceBeforeNum = toNumber(t.balance_before);
  const balanceAfterNum = toNumber(t.balance_after);
  const meta = t.metadata as Record<string, unknown> | null;
  const invItemId = meta?.inventory_item_id as string | undefined;
  // Admin inventory/voucher REMOVAL records carry `inventory_item_id` /
  // `kind` in metadata but are NOT card sales — they're manual clawbacks
  // logged as admin_balance_adjustment rows so they surface in this feed.
  // Don't slap a "Card sale" label on them (the description already says
  // "Inventory removed: …" / "Voucher removed: …").
  const metaKind = meta?.kind as string | undefined;
  const isAdminRemovalRecord =
    metaKind === "inventory_removal" || metaKind === "voucher_removal";

  return {
    id: t.id,
    type: t.type,
    amount: toNumber(t.amount),
    balanceBefore: balanceBeforeNum,
    balanceAfter: balanceAfterNum,
    worthBefore: balanceBeforeNum,
    worthAfter: balanceAfterNum,
    description: t.description,
    status: t.status,
    gameSessionId: t.game_session_id,
    packId: null,
    packName: null,
    cardsValue: null,
    gameResult: null,
    inventoryValue: 0,
    soldCard:
      invItemId && !isAdminRemovalRecord
        ? { name: "Card sale", imageUrl: null, rarity: null }
        : null,
    cryptoAsset: t.crypto_asset,
    cryptoAmount: t.crypto_amount ? toNumber(t.crypto_amount) : null,
    exchangeRate: t.exchange_rate ? toNumber(t.exchange_rate) : null,
    blockchainTxHash: t.blockchain_tx_hash,
    sourceAddress: t.source_address,
    destinationAddress: t.destination_address,
    depositAddressId: t.deposit_address_id,
    failureReason: t.failure_reason,
    metadata: t.metadata ? JSON.parse(JSON.stringify(t.metadata)) : null,
    fireblocksTxId: t.fireblocks_tx_id,
    externalTxId: t.external_tx_id,
    createdAt: t.created_at.toISOString(),
    updatedAt: t.updated_at.toISOString(),
    borrowPercentage: null,
    borrowedAmountUsd: null,
    sponsorshipPercentage: null,
    battleId: null,
    battleMode: null,
    battlePending: null,
    hasPassword: null,
    battleWinnings: null,
    battleOutcomePending: null,
    upgraderResult: null,
    upgraderWinnings: null,
    upgraderTargetMultiplier: null,
    upgraderTargetChance: null,
    upgraderTargetChanceDerived: null,
    upgraderHouseEdge: null,
    // Financial-only rows are always real, ledger-backed rows (this light
    // mapper serves the deposits/withdrawals feed — no synthetic double-down).
    syntheticKind: null,
    doubleDownResult: null,
    doubleDownAmount: null,
    // Instant (early-claimed) rakeback flag. null on non-rakeback rows or
    // when the early-claim column is absent on this DB env (drift-safe).
    isInstantRakeback:
      t.type === "rakeback_claim"
        ? instantRakebackIds?.has(t.id) ?? false
        : null,
  };
}

async function getUserFinancialTransactionsLight(
  db: Awaited<ReturnType<typeof getDb>>,
  where: Prisma.ledger_transactionsWhereInput,
  page: number,
  perPage: number,
) {
  const [transactions, total] = await Promise.all([
    db.ledger_transactions.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    db.ledger_transactions.count({ where }),
  ]);

  // Instant-rakeback enrichment — flag which rakeback_claim rows on this page
  // were early-claimed (rakeback_claims.last_preclaim_at non-null), joined by
  // ledger_tx_id. Drift-safe + best-effort: a failure (or an env without the
  // column) just leaves rows labeled the plain "Rakeback".
  let instantRakebackIds = new Set<string>();
  const rakebackLedgerIds = transactions
    .filter((t) => t.type === "rakeback_claim")
    .map((t) => t.id);
  if (rakebackLedgerIds.length > 0) {
    try {
      instantRakebackIds = await getInstantRakebackLedgerTxIds(
        rakebackLedgerIds,
      );
    } catch (e) {
      console.error(
        "[getUserFinancialTransactionsLight] instant-rakeback lookup failed (non-fatal):",
        e,
      );
    }
  }

  return {
    data: transactions.map((t) => mapFinancialLedgerRow(t, instantRakebackIds)),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}

// ── Post-battle DOUBLE-DOWN (decoupled source for the inline gaming feed) ──
//
// A resolved post-battle double-down round is surfaced as its OWN first-class
// row in the gaming transactions feed. It is read from the SAME authoritative
// table as getUserDoubleDownHistory (src/lib/queries/double-down.ts) —
// `battle_double_down_offers` for THIS user, keyed on the (user_id,status)
// index — NOT derived from whichever battle_bet rows happen to be on the
// current ledger page. This is what makes the row a "proper system": every one
// of the user's rounds is counted and paginated, independent of the page.
//
// `battle_double_down_offers` is NOT modeled in prisma/schema.prisma (no
// generated accessor), so this is hand-written READ-ONLY raw SQL through the
// prod client. MAIN is strictly read-only — SELECT only.

type SyntheticDdRow = {
  /** battle_double_down_offers.id — globally unique, used as the row id. */
  id: string;
  battleGameSessionId: string | null;
  result: "win" | "lose";
  /**
   * House-POV amount = on a WIN the REAL credited payout (the paired
   * `battle_double_down_payout` voucher's `value`, falling back to the stake if
   * the voucher value is missing), on a LOSE the forfeited stake
   * (`won_amount_usd`).
   */
  amount: number;
  /** When the round settled — the timestamp the synthetic row sorts by. */
  resolvedAt: Date;
};

/**
 * Read ALL of a user's resolved double-down rounds, newest first. Indexed
 * (user_id,status) → Bitmap Index Scan. Non-fatal: on any error (e.g. a DB
 * without the table) returns [] so the gaming feed still renders its ledger
 * rows. Payout source = the paired payout voucher's real value (reconciles to
 * the voucher_redeemed ledger), NO multiplier — mirrors double-down.ts.
 */
async function fetchUserDoubleDownRows(
  db: Awaited<ReturnType<typeof getDb>>,
  canonicalUserId: string,
): Promise<SyntheticDdRow[]> {
  try {
    const rows = await db.$queryRaw<
      {
        id: string;
        game_session_id: string | null;
        result: "win" | "lose";
        won_amount_usd: string;
        payout_amount_usd: string | null;
        resolved_at: Date | null;
        created_at: Date;
      }[]
    >(Prisma.sql`
      SELECT o.id,
             o.game_session_id,
             o.result,
             o.won_amount_usd,
             o.resolved_at,
             o.created_at,
             CASE WHEN o.result = 'win' THEN v.value::text END AS payout_amount_usd
      FROM battle_double_down_offers o
      LEFT JOIN vouchers v
        ON v.id = o.won_voucher_id
       AND v.origin = 'battle_double_down_payout'
      WHERE o.user_id = ${canonicalUserId}
        AND o.status = 'resolved'
        AND o.result IS NOT NULL
      ORDER BY COALESCE(o.resolved_at, o.created_at) DESC
    `);
    const ddNum = (v: string | null): number | null => {
      if (v === null) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    return rows.map((r) => ({
      id: r.id,
      battleGameSessionId: r.game_session_id,
      result: r.result,
      amount:
        r.result === "win"
          ? ddNum(r.payout_amount_usd) ?? ddNum(r.won_amount_usd) ?? 0
          : ddNum(r.won_amount_usd) ?? 0,
      resolvedAt: r.resolved_at ?? r.created_at,
    }));
  } catch (e) {
    console.error(
      "[getUserTransactions] double-down lookup failed (non-fatal):",
      e,
    );
    return [];
  }
}

/**
 * Build a complete, neutral Transaction row for a synthetic double-down event.
 * The row carries NO ledger balance movement (a LOSE writes no ledger row at
 * all), so balance/worth fields are neutralized and the UI renders "—" for
 * them. `type` stays the real `battle_bet` enum value so the field remains a
 * valid ledger_transaction_type; the UI branches on `syntheticKind` instead.
 * House-POV colors are derived in the UI from `doubleDownResult`.
 */
function buildDoubleDownRow(d: SyntheticDdRow): Transaction {
  const isWin = d.result === "win";
  const iso = d.resolvedAt.toISOString();
  return {
    id: d.id,
    type: "battle_bet",
    amount: d.amount,
    balanceBefore: 0,
    balanceAfter: 0,
    worthBefore: 0,
    worthAfter: 0,
    description: isWin
      ? "Double-down — gambled battle winnings and won"
      : "Double-down — gambled battle winnings and lost",
    status: "completed",
    gameSessionId: d.battleGameSessionId,
    packId: null,
    packName: null,
    cardsValue: null,
    gameResult: null,
    inventoryValue: 0,
    soldCard: null,
    cryptoAsset: null,
    cryptoAmount: null,
    exchangeRate: null,
    blockchainTxHash: null,
    sourceAddress: null,
    destinationAddress: null,
    depositAddressId: null,
    failureReason: null,
    metadata: null,
    fireblocksTxId: null,
    externalTxId: null,
    createdAt: iso,
    updatedAt: iso,
    borrowPercentage: null,
    borrowedAmountUsd: null,
    sponsorshipPercentage: null,
    battleId: null,
    battleMode: null,
    battlePending: null,
    hasPassword: null,
    battleWinnings: null,
    battleOutcomePending: null,
    upgraderResult: null,
    upgraderWinnings: null,
    upgraderTargetMultiplier: null,
    upgraderTargetChance: null,
    upgraderTargetChanceDerived: null,
    upgraderHouseEdge: null,
    syntheticKind: "double_down",
    doubleDownResult: d.result,
    doubleDownAmount: d.amount,
    isInstantRakeback: null,
  };
}

/**
 * For each timestamp in `timestamps`, count the ledger rows (under the SAME
 * `where` as the page query) that are STRICTLY NEWER (created_at > ts). Used to
 * position each synthetic double-down row in the merged global timeline without
 * scanning the whole ledger. One round-trip per timestamp, but the double-down
 * set is tiny per user (indexed lookup), so this is a handful of cheap indexed
 * COUNTs. Returns counts aligned to the input order.
 */
async function countLedgerNewerThanEach(
  db: Awaited<ReturnType<typeof getDb>>,
  where: Prisma.ledger_transactionsWhereInput,
  timestamps: Date[],
): Promise<number[]> {
  if (timestamps.length === 0) return [];
  return Promise.all(
    timestamps.map((ts) =>
      db.ledger_transactions.count({
        where: { AND: [where, { created_at: { gt: ts } }] },
      }),
    ),
  );
}

export async function getUserTransactions(
  userId: string,
  page: number = 1,
  perPage: number = 20,
  filters?: { type?: string; types?: string[]; status?: string; dateFrom?: string; dateTo?: string },
  // Adjustment-visibility owner gate, RESOLVED BY THE CALLER.
  //
  // Normally this function resolves the owner gate itself via verifySession()
  // + isAdjustmentVisibilityOwner() (see the security block below). That
  // session read CANNOT run inside an `unstable_cache` callback (cookies()
  // throws → it would fail-closed and hide adjustments from the owner), which
  // is why the Finances feed couldn't be cached. A trusted server caller that
  // has ALREADY resolved the same gate on the request (via the very same
  // isAdjustmentVisibilityOwner helper) may pass the result here to skip the
  // in-function session read — security-equivalent, just resolved outside the
  // cache. When `undefined` (every existing caller, incl. the
  // fetchUserTransactions action) the in-function resolution is used unchanged.
  viewerIsOwnerOverride?: boolean,
): Promise<PaginatedTransactions> {
  const db = await getDb();
  const where: Prisma.ledger_transactionsWhereInput = {
    user_id: userId,
    // FAKE-BALANCE: hide official_stream adjustments from the per-user
    // activity / transactions feed (owner-designated fake balance is never
    // surfaced). Combines with the optional type filter below.
    NOT: officialStreamAdjustmentPrismaWhere(),
  };

  // IMPORTANT: filter the requested type(s) against the LIVE enum, not just
  // the generated Prisma enum. The schema/generated client is AHEAD of prod
  // for the un-launched upgrader feature (`upgrader_bet` / `upgrader_payout`
  // exist in the generated enum but NOT in the prod `ledger_transaction_type`
  // enum). Passing such a member into `type: { in: [...] }` makes Postgres
  // throw `22P02 invalid input value for enum`, which took the WHOLE query
  // (and thus the user-detail Gaming tab — its GAMING_TYPES list includes the
  // upgrader members) down to an error/empty. Intersecting with the live enum
  // drops the not-yet-migrated members and self-heals once prod migrates.
  if (filters?.type && filters.type !== "all") {
    if (await isLiveLedgerTxType(filters.type)) {
      where.type = filters.type as ledger_transaction_type;
    }
  } else if (filters?.types && filters.types.length > 0) {
    const validTypes = await filterLedgerTxTypesLive(filters.types);
    if (validTypes.length > 0) where.type = { in: validTypes };
  }
  if (filters?.status && filters.status !== "all") {
    where.status = filters.status as Prisma.Enumledger_transaction_statusFilter["equals"];
  }
  if (filters?.dateFrom || filters?.dateTo) {
    const dateFilter: { gte?: Date; lte?: Date } = {};
    if (filters.dateFrom) {
      const d = new Date(filters.dateFrom);
      if (!isNaN(d.getTime())) dateFilter.gte = d;
    }
    if (filters?.dateTo) {
      const to = new Date(filters.dateTo);
      if (!isNaN(to.getTime())) {
        to.setDate(to.getDate() + 1);
        dateFilter.lte = to;
      }
    }
    if (dateFilter.gte || dateFilter.lte) {
      where.created_at = dateFilter;
    }
  }

  const canonicalUserId = await resolveCanonicalUserId(db, userId);
  if (!canonicalUserId) {
    return {
      data: [],
      total: 0,
      page,
      perPage,
      totalPages: 0,
    };
  }
  where.user_id = canonicalUserId;

  // ── BLACKLISTED-USER WITHDRAWAL SUPPRESSION ─────────────────────────
  //
  // A user on the excluded_users blacklist (getExcludedUserIds — the RAW
  // set, applied to EVERYONE incl. owners) is fully hidden across the admin
  // (owner request 2026-07-01). On the per-user surfaces that still render
  // for them (their /users/[id] page stays viewable), their WITHDRAWAL rows
  // + amounts are suppressed at this single chokepoint so both the rows and
  // the `count` (page totals) omit them — the Deposits & Withdrawals feed,
  // the Withdrawals filter segment, the Recent Activity timeline, load-more
  // via fetchUserTransactions, and the transaction-detail modal all read
  // this function, so they all drop the withdrawal entries consistently.
  // Deposits and every other type are untouched.
  const excludedIds = await getExcludedUserIds();
  if (excludedIds.includes(canonicalUserId)) {
    const hideWithdrawals: Prisma.ledger_transactionsWhereInput = {
      type: { notIn: [...BLACKLIST_HIDDEN_WITHDRAWAL_TYPES] },
    };
    const existingAnd = where.AND
      ? Array.isArray(where.AND)
        ? where.AND
        : [where.AND]
      : [];
    where.AND = [...existingAnd, hideWithdrawals];
  }

  // ── OWNER-ONLY ADMIN-ADJUSTMENT VISIBILITY (security) ───────────────
  //
  // No admin except the owner `motha` may see ANY admin balance adjustment
  // on a user. Enforced HERE at the single query chokepoint so the rows are
  // never sent to the client for a non-owner viewer — across EVERY surface
  // that reads this function: the dedicated adjustments block, the Deposits
  // & Withdrawals feed (admin_balance_adjustment is one of FINANCIAL_TYPES),
  // the Recent Activity timeline, the transaction-detail modal (renders only
  // rows already in the table), and the paginated/filtered re-fetch via the
  // fetchUserTransactions server action.
  //
  // The viewer is resolved from the authenticated session (verifySession is
  // cache()'d → free within a request); isAdjustmentVisibilityOwner reads the
  // ADMIN DB read-only and fails closed. A non-owner gets a hard
  // `type != 'admin_balance_adjustment'` exclusion ANDed into the where, so
  // both the rows and the `count` (page totals) omit adjustments entirely —
  // a non-owner can't even infer one exists via a count or an empty page.
  let viewerIsOwner = false;
  if (viewerIsOwnerOverride !== undefined) {
    // Caller already resolved the gate on the request (outside cache scope).
    viewerIsOwner = viewerIsOwnerOverride;
  } else {
    try {
      const session = await verifySession();
      viewerIsOwner = await isAdjustmentVisibilityOwner(session.userId);
    } catch {
      // No resolvable session → fail closed (hide adjustments). This path is
      // not expected: every caller runs inside an authenticated admin request.
      viewerIsOwner = false;
    }
  }
  if (!viewerIsOwner) {
    const hideAdjustments: Prisma.ledger_transactionsWhereInput = {
      type: { not: "admin_balance_adjustment" },
    };
    const existingAnd = where.AND
      ? Array.isArray(where.AND)
        ? where.AND
        : [where.AND]
      : [];
    where.AND = [...existingAnd, hideAdjustments];
  } else if (isMothaOnlyAdjustmentsProfile(canonicalUserId)) {
    // Owner viewer: the legacy per-profile carve-out still applies on the
    // one designated profile — show ONLY motha-made adjustments, hide other
    // admins' admin_balance_adjustment rows across financial + adjustment
    // feeds. (For a non-owner viewer the broader gate above already hid all
    // adjustments, so this branch is owner-only.)
    const mothaLedgerIds = await getMothaAdjustmentLedgerTxIdsForUser(
      canonicalUserId,
    );
    const mothaScope: Prisma.ledger_transactionsWhereInput =
      mothaLedgerIds.length > 0
        ? {
            OR: [
              { type: { not: "admin_balance_adjustment" } },
              {
                type: "admin_balance_adjustment",
                id: { in: mothaLedgerIds },
              },
            ],
          }
        : { type: { not: "admin_balance_adjustment" } };
    const existingAnd = where.AND
      ? Array.isArray(where.AND)
        ? where.AND
        : [where.AND]
      : [];
    where.AND = [...existingAnd, mothaScope];
  }

  if (isFinancialOnlyFilter(filters)) {
    return getUserFinancialTransactionsLight(db, where, page, perPage);
  }

  // ── Decoupled DOUBLE-DOWN source (PROPER system) ──────────────────────
  // Post-battle double-down rounds are surfaced as first-class rows inside
  // this gaming feed. A LOST round writes NO ledger row (the winnings are
  // forfeited entirely) and even a WON round's payout voucher is not a
  // ledger row on this game_session, so the double-down is INVISIBLE to the
  // ledger query. We therefore read the rounds directly from the SAME
  // authoritative source as getUserDoubleDownHistory (double-down.ts) —
  // `battle_double_down_offers` for THIS user, keyed on (user_id,status)
  // (indexed → Bitmap Index Scan), DECOUPLED from whichever battle_bet rows
  // happen to land on the current ledger page. Each resolved round becomes a
  // synthetic row dated at `resolved_at`, merged into the desc-by-time feed
  // and counted in `total` so pagination stays exact (a page never silently
  // exceeds perPage; page counts add up). MAIN is READ-ONLY — SELECT only;
  // `battle_double_down_offers` is not modeled in prisma/schema.prisma, so
  // this is hand-written parameterized raw SQL through the prod client.
  //
  // House-POV (verified against the payout-voucher model, read-only on prod):
  //   • WIN  → user kept MORE money (paid a `battle_double_down_payout`
  //            voucher whose `value` == the credited amount) → HOUSE LOSS →
  //            🔴 rose. `amount` = the REAL voucher value (no multiplier),
  //            falling back to the stake if the voucher value is missing.
  //   • LOSE → user forfeited the whole win → HOUSE WIN → 🟢 emerald.
  //            `amount` = the forfeited stake (`won_amount_usd`).
  // Non-fatal: a failure here must NOT take down the gaming tab — on error
  // the synthetic list stays empty and only real ledger rows render.
  const ddSynthetic = await fetchUserDoubleDownRows(db, canonicalUserId);
  const ddTotal = ddSynthetic.length;

  // Over-fetch the ledger window by `ddTotal` on each side so the in-memory
  // merge below has every ledger row that could fall inside the merged page
  // slice: at most `ddTotal` synthetic rows can shift the ledger boundary in
  // either direction. DD volume is tiny (indexed per-user), so this is a
  // negligible over-read. When there are no DD rows this is exactly the old
  // skip/take.
  const rawOffset = (page - 1) * perPage;
  const fetchSkip = Math.max(0, rawOffset - ddTotal);
  const fetchTake = perPage + ddTotal + (rawOffset - fetchSkip);

  const [transactions, ledgerTotal] = await Promise.all([
    db.ledger_transactions.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: fetchSkip,
      take: fetchTake,
      include: {
        game_sessions_ledger_transactions_game_session_idTogame_sessions: {
          select: {
            id: true,
            game_id: true,
            game_type: true,
            result: true,
            bet_amount: true,
            // One-to-one link to the battle (game_session →
            // battle_participants → battles). battle_id is the
            // authoritative id for the "watch live" link; team_number is
            // compared against battles.winner_team to decide win/loss
            // (the reliable signal — game_sessions.result does NOT track
            // who won the battle).
            battle_participants: {
              select: { battle_id: true, team_number: true },
            },
            provably_fair_results: {
              // result_metadata + battle_id are needed for the borrow
              // badge — solo opens carry the % in metadata, battle
              // opens link to a battle whose borrow_percentage is on
              // the battles table (joined below).
              select: {
                battle_id: true,
                result_metadata: true,
                user_inventory: { select: { value_at_obtained: true } },
              },
            },
          },
        },
      },
    }),
    db.ledger_transactions.count({ where }),
  ]);

  // Upgrader-target batch lookup KICKED here (not awaited) — it depends only
  // on `transactions` (already resolved above), NOT on the battle lookup /
  // inventory+voucher fan-out / battle-winnings groupBy that follow. Those
  // were previously all sequential awaits BEFORE this one started, adding a
  // full extra round-trip of latency to every Gaming-tab load even though
  // this query is fully independent of them. Kicking it now lets it run
  // concurrently with that work; it's awaited later at its point of use
  // (see `upgraderBetByLedgerId` below). `fetchUpgraderTargetByLedgerTxIds`
  // never rejects (internal try/catch) and no-ops instantly on an empty id
  // list, so this is free for pages with no upgrader_bet rows.
  const upgraderBetLedgerIds = transactions
    .filter((t) => t.type === "upgrader_bet")
    .map((t) => t.id);
  const upgraderBetByLedgerIdPromise = fetchUpgraderTargetByLedgerTxIds(
    db,
    upgraderBetLedgerIds,
  );

  // Batch-fetch battle rows for every battle referenced on this page —
  // both from PF results (borrow badge) and from battle_bet participants
  // (win/loss + winnings). One query yields borrow_percentage AND the
  // outcome (winner_team + status), so we don't hit the battles table
  // twice.
  //
  // CRITICAL: auxiliary lookup — same convention as getTransactions. A
  // failure here must NOT take down the whole /users/[id] activity tab.
  // Wrap in try/catch; on failure, badges/outcome are just absent for the
  // page-load and rows still render.
  const battleIdsToFetch = new Set<string>();
  for (const t of transactions) {
    const gs = t.game_sessions_ledger_transactions_game_session_idTogame_sessions;
    if (gs?.battle_participants?.battle_id) {
      battleIdsToFetch.add(gs.battle_participants.battle_id);
    }
    for (const pf of gs?.provably_fair_results ?? []) {
      if (pf.battle_id) battleIdsToFetch.add(pf.battle_id);
    }
  }
  const battleBorrowMap = new Map<string, number>();
  // battle id → sponsorship % (0 = none, 100 = fully sponsored: the
  // creator paid the whole entry so others join free).
  const battleSponsorshipMap = new Map<string, number>();
  const battleOutcomeMap = new Map<
    string,
    { winnerTeam: number | null; status: string }
  >();
  // battle id → has-password flag. BOOLEAN ONLY — never the plaintext.
  // The plaintext is fetched on demand via revealBattlePassword (which
  // audit-logs every reveal); embedding the value here would leak it
  // into the SSR payload on every transactions-tab paint. Same SSR-safe
  // pattern getBattleDetail uses (see ce56eb6).
  const battleHasPasswordMap = new Map<string, boolean>();
  // battle id → raw mode enum string ("normal" | "jackpot" | "group" |
  // "hp_rush" | "lowest"). Surfaced as a structured "Battle Mode" row in
  // the transaction-detail modal; the human-readable label is applied there.
  const battleModeMap = new Map<string, string>();
  if (battleIdsToFetch.size > 0) {
    try {
      const battleRows = await db.battles.findMany({
        where: { id: { in: [...battleIdsToFetch] } },
        select: {
          id: true,
          mode: true,
          borrow_percentage: true,
          sponsorship_percentage: true,
          winner_team: true,
          status: true,
          // Select the column so we can derive a boolean below — the raw
          // string never escapes this function.
          password: true,
        },
      });
      for (const b of battleRows) {
        battleBorrowMap.set(b.id, b.borrow_percentage ?? 0);
        battleSponsorshipMap.set(b.id, b.sponsorship_percentage ?? 0);
        battleModeMap.set(b.id, b.mode);
        battleOutcomeMap.set(b.id, {
          winnerTeam: b.winner_team,
          status: b.status,
        });
        battleHasPasswordMap.set(
          b.id,
          b.password !== null && b.password.length > 0,
        );
      }
    } catch (e) {
      console.error(
        "[getUserTransactions] battle lookup failed (non-fatal):",
        e,
      );
    }
  }

  // Three independent lookup chains run in parallel:
  //   1) pack-name resolution (two-step: packs → user_packs fallback)
  //   2) card-sale inventory + card detail (two-step: inventory → cards)
  //   3) full user inventory snapshot for per-tx valuation
  const gameSessionsWithPacks = transactions
    .filter((t) => t.game_sessions_ledger_transactions_game_session_idTogame_sessions?.game_type === "pack")
    .map((t) => t.game_sessions_ledger_transactions_game_session_idTogame_sessions!);

  const packGameIds = [...new Set(gameSessionsWithPacks.map((gs) => gs.game_id).filter(Boolean))] as string[];

  const cardSaleItemIds = transactions
    .filter((t) => t.type === "card_sale" && t.metadata && typeof t.metadata === "object")
    .map((t) => (t.metadata as Record<string, unknown>)?.inventory_item_id)
    .filter((id): id is string => typeof id === "string");

  async function resolvePacks(): Promise<Map<string, { id: string; name: string }>> {
    const result = new Map<string, { id: string; name: string }>();
    if (packGameIds.length === 0) return result;
    const directPacks = await db.packs.findMany({
      where: { id: { in: packGameIds } },
      select: { id: true, name: true },
    });
    for (const p of directPacks) result.set(p.id, p);
    const remaining = packGameIds.filter((id) => !result.has(id));
    if (remaining.length > 0) {
      const userPacks = await db.user_packs.findMany({
        where: { id: { in: remaining } },
        include: { packs: { select: { id: true, name: true } } },
      });
      for (const up of userPacks) {
        if (up.packs) result.set(up.id, up.packs);
      }
    }
    return result;
  }

  async function resolveInventoryWithCards() {
    if (cardSaleItemIds.length === 0) {
      return { inventoryItems: [] as Array<{ id: string; card_id: string; source_type: string | null; source_id: string | null }>, cards: [] as Array<{ id: string; name: string; image_url: string | null; rarity: string | null }> };
    }
    const inventoryItems = await db.user_inventory.findMany({
      where: { id: { in: cardSaleItemIds } },
      select: { id: true, card_id: true, source_type: true, source_id: true },
    });
    const cardIds = [...new Set(inventoryItems.map((i) => i.card_id))];
    const cards = cardIds.length > 0
      ? await db.cards.findMany({
          where: { id: { in: cardIds } },
          select: { id: true, name: true, image_url: true, rarity: true },
        })
      : [];
    return { inventoryItems, cards };
  }

  // Newest tx timestamp on this page (rows are ordered desc). An
  // inventory item obtained AFTER this instant fails `obtained_at <= ts`
  // for every tx on the page, so it can never contribute to the
  // held-value snapshot here — bound the inventory pull by it to avoid
  // dragging the user's entire lifetime inventory back on deep pages.
  // Vouchers are NOT bounded the same way: `allVouchers` is also used
  // below to value session-spun voucher excess by origin_id, where a
  // voucher created after the bet tx (battle resolves later) still
  // belongs to a session shown on the page.
  const maxTxTs =
    transactions.length > 0 ? transactions[0].created_at : undefined;

  const [packByGameId, invAndCards, allInventory, allVouchers] =
    await Promise.all([
      resolvePacks(),
      resolveInventoryWithCards(),
      db.user_inventory.findMany({
        where: {
          user_id: canonicalUserId,
          ...(maxTxTs ? { obtained_at: { lte: maxTxTs } } : {}),
        },
        select: {
          value_at_obtained: true,
          obtained_at: true,
          sold_at: true,
          exchanged_at: true,
          // Cards locked for card_withdrawal leave the user's holdings
          // even before sold_at/exchanged_at flip — they're awaiting
          // shipment. The worth sweep below treats this timestamp as a
          // disposal event so a card_withdrawal row's Worth After
          // drops by the withdrawn cards' value, matching the dashboard's
          // inventory aggregate which already filters by this.
          withdrawal_locked_at: true,
        },
      }),
      // Vouchers are held value too — battle / exchange excess gets
      // parked as a voucher until the user redeems it. Pulled so the
      // per-tx held-value snapshot can count them alongside cards.
      db.vouchers.findMany({
        where: { user_id: canonicalUserId },
        select: { value: true, created_at: true, claimed_at: true, origin_id: true },
      }),
    ]);
  const { inventoryItems, cards } = invAndCards;
  const cardMap = new Map(cards.map((c) => [c.id, c]));
  const inventoryMap = new Map(inventoryItems.map((i) => [i.id, { ...i, card: cardMap.get(i.card_id) ?? null }]));
  // Held value at each tx timestamp = unsold/unexchanged cards PLUS
  // unclaimed vouchers, each valued as of that moment (held = created
  // on/before the tx and not yet disposed/claimed as of it). Vouchers
  // are included because a voucher is value the user is holding exactly
  // like card inventory — the same way the PnL formula subtracts both.
  //
  // Computed as a single chronological sweep instead of an
  // O(tx × inventory) double-loop. The held value over time is a step
  // function: each held unit contributes +value from when it's obtained
  // until (but not including) when it leaves. So emit a +value event at
  // the obtain time and a −value event at the disposal time, sort all
  // events by time, then walk the page's transactions in ascending time
  // applying every event at-or-before each tx's timestamp. The running
  // sum at a tx's timestamp equals exactly the original predicate
  // (`obtained_at <= ts AND disposal > ts`): an add at `ts` is included
  // (<=), a removal at `ts` is also applied (<=), which nets the unit
  // out — matching the strict `disposal > ts` exclusion. Disposal time
  // is the EARLIER of sold_at / exchanged_at, since the unit drops out
  // as soon as either trips.
  type SweepEvent = { t: number; d: number };
  const sweepEvents: SweepEvent[] = [];
  for (const item of allInventory) {
    const value = toNumber(item.value_at_obtained);
    sweepEvents.push({ t: item.obtained_at.getTime(), d: value });
    // Card leaves the user's holdings on the EARLIEST of: sold_at,
    // exchanged_at, or withdrawal_locked_at. withdrawal_locked_at is
    // included so cards en-route for a card_withdrawal are removed
    // from "held value" at the moment they're locked (matches the
    // dashboard's inventory aggregate, which already filters them
    // out). Without this, a card_withdrawal row showed Worth Before
    // == Worth After because the withdrawn cards stayed counted as
    // held even after they left the platform.
    const candidates = [
      item.sold_at ? item.sold_at.getTime() : null,
      item.exchanged_at ? item.exchanged_at.getTime() : null,
      item.withdrawal_locked_at ? item.withdrawal_locked_at.getTime() : null,
    ].filter((t): t is number => t !== null);
    if (candidates.length > 0) {
      sweepEvents.push({ t: Math.min(...candidates), d: -value });
    }
  }
  for (const v of allVouchers) {
    const value = toNumber(v.value);
    sweepEvents.push({ t: v.created_at.getTime(), d: value });
    if (v.claimed_at) sweepEvents.push({ t: v.claimed_at.getTime(), d: -value });
  }
  sweepEvents.sort((a, b) => a.t - b.t);

  // Transactions ascending by timestamp so the sweep advances forward
  // once. Keep ids to write the map; the returned `data` order is
  // unaffected (it maps over the original `transactions` array).
  const txAsc = transactions
    .map((t) => ({ id: t.id, t: t.created_at.getTime() }))
    .sort((a, b) => a.t - b.t);

  // Two snapshots per tx from one forward sweep:
  //   • "before" = held value STRICTLY before the tx (events t < tx.t)
  //   • "after"  = held value AT the tx (events t <= tx.t)
  // The gap between them is exactly the items this tx added/removed at its
  // own instant (e.g. an atomic pack open's pulls), so Worth Before
  // excludes just-won items WITHOUT a cardsValue back-out. It's correct
  // for battles too: a battle's pulls land at a LATER timestamp
  // (resolution) than the bet row, so they're in NEITHER snapshot of the
  // bet row — Worth Before/After around the bet differ only by the cash bet.
  const inventoryValueByTx = new Map<string, number>();
  const inventoryValueBeforeByTx = new Map<string, number>();
  let sweepIdx = 0;
  let runningHeld = 0;
  for (const tx of txAsc) {
    while (sweepIdx < sweepEvents.length && sweepEvents[sweepIdx].t < tx.t) {
      runningHeld += sweepEvents[sweepIdx].d;
      sweepIdx++;
    }
    inventoryValueBeforeByTx.set(tx.id, runningHeld);
    while (sweepIdx < sweepEvents.length && sweepEvents[sweepIdx].t <= tx.t) {
      runningHeld += sweepEvents[sweepIdx].d;
      sweepIdx++;
    }
    inventoryValueByTx.set(tx.id, runningHeld);
  }

  // Voucher excess a game session produced (battle_excess_to_voucher /
  // pack_borrow_to_voucher) is parked as a voucher whose origin_id is
  // the originating game_session id. Map session id → total voucher
  // value so the value WON below counts the voucher as winnings, not
  // just the cards — a voucher is value the user pulled out of the play.
  const voucherValueByGameSession = new Map<string, number>();
  for (const v of allVouchers) {
    if (v.origin_id) {
      voucherValueByGameSession.set(
        v.origin_id,
        (voucherValueByGameSession.get(v.origin_id) ?? 0) + toNumber(v.value),
      );
    }
  }

  // Value WON per gaming transaction = card winnings (from the session's
  // provably_fair_results) PLUS any voucher excess that session spun off.
  // For battles we only trust the sum once game_sessions.result is
  // non-null (otherwise PF rows are still inserted round-by-round and the
  // number is a moving target — the admin would see a fake "losing"
  // display). Pack openings are atomic, so they're always safe to read.
  const cardsValueByTx = new Map<string, number>();
  for (const t of transactions) {
    const gs = t.game_sessions_ledger_transactions_game_session_idTogame_sessions;
    if (!gs) continue;
    const sessionVoucher = voucherValueByGameSession.get(gs.id) ?? 0;

    if (t.type === "pack_opening") {
      const cards = gs.provably_fair_results.reduce(
        (sum, pf) => sum + (pf.user_inventory ? toNumber(pf.user_inventory.value_at_obtained) : 0),
        0
      );
      cardsValueByTx.set(t.id, cards + sessionVoucher);
    } else if (t.type === "battle_bet" || t.type === "battle_sponsorship") {
      if (gs.result !== null) {
        const cards = gs.provably_fair_results.reduce(
          (sum, pf) => sum + (pf.user_inventory ? toNumber(pf.user_inventory.value_at_obtained) : 0),
          0
        );
        cardsValueByTx.set(t.id, cards + sessionVoucher);
      }
    }
  }

  // ── Battle win/loss + winnings (for battle_bet rows) ──────────────
  // Win/loss is decided by battles.winner_team vs this user's
  // battle_participant.team_number (the reliable signal —
  // game_sessions.result does NOT track who won the battle). The
  // winnings are the user's OWN realized take: the cards that actually
  // landed in their inventory from the battle, i.e. user_inventory rows
  // with source_type='battle' and source_id = the bet's game_session_id
  // (verified: for source_type IN ('pack','battle'), user_inventory
  // .source_id IS the game_session_id — see creators-pnl.ts /
  // creators-types.ts). Valued at value_at_obtained, this equals what
  // the user truly won and matches their inventory/worth — unlike the
  // battle's gross card value, which over-counts cards the user never
  // kept.
  const wonGameSessionIds: string[] = [];
  for (const t of transactions) {
    if (t.type !== "battle_bet" || !t.game_session_id) continue;
    const gs = t.game_sessions_ledger_transactions_game_session_idTogame_sessions;
    const bId = gs?.battle_participants?.battle_id ?? null;
    const userTeam = gs?.battle_participants?.team_number ?? null;
    const outcome = bId ? battleOutcomeMap.get(bId) : null;
    if (
      outcome &&
      outcome.status === "completed" &&
      outcome.winnerTeam != null &&
      userTeam != null &&
      userTeam === outcome.winnerTeam
    ) {
      wonGameSessionIds.push(t.game_session_id);
    }
  }

  // Battle winnings = kept cards (user_inventory) PLUS the paired
  // battle_excess_to_voucher voucher leg. Per the house "Voucher == Card"
  // rule, a battle win can pay out as cards + a leftover voucher (e.g.
  // $144 in cards + $183.03 voucher = $327.03 total). The voucher row
  // lives in `vouchers` with `origin = 'battle_excess_to_voucher'` and
  // `origin_id = game_sessions.id` (confirmed via probe — the ledger
  // `battle_excess_to_voucher` row carries `game_session_id = NULL`, so
  // joining through `vouchers.origin_id` is the only reliable link).
  // Without this leg, a real house LOSS gets mis-rendered as a small
  // house WIN because the merged P&L cell only sees the cards.
  //
  // `voucherValueByGameSession` is already built above (line ~639) from
  // `allVouchers` and KEYED on `vouchers.origin_id` — for a winning
  // battle bet that's the same `game_session_id` the bet row is keyed on,
  // so we can fold it in without a second query.
  const battleWinningsByGsid = new Map<string, number>();
  if (wonGameSessionIds.length > 0) {
    try {
      const grouped = await db.user_inventory.groupBy({
        by: ["source_id"],
        where: {
          user_id: canonicalUserId,
          source_type: "battle",
          source_id: { in: wonGameSessionIds },
        },
        _sum: { value_at_obtained: true },
      });
      for (const g of grouped) {
        if (g.source_id) {
          battleWinningsByGsid.set(
            g.source_id,
            toNumber(g._sum.value_at_obtained ?? 0),
          );
        }
      }
    } catch (e) {
      console.error(
        "[getUserTransactions] battle winnings (inventory) lookup failed (non-fatal):",
        e,
      );
    }
    // Fold in the voucher leg of the win (Voucher == Card). Any won gsid
    // that produced a battle_excess_to_voucher voucher gets its value
    // added; gsids with no voucher (cards-only win) are unchanged.
    for (const gsid of wonGameSessionIds) {
      const voucherValue = voucherValueByGameSession.get(gsid);
      if (voucherValue && voucherValue > 0) {
        battleWinningsByGsid.set(
          gsid,
          (battleWinningsByGsid.get(gsid) ?? 0) + voucherValue,
        );
      }
    }
  }

  // (Post-battle double-down rows are read decoupled up-front — see
  // fetchUserDoubleDownRows / the ddSynthetic list above — and merged into the
  // paginated feed at the end of this function, so there is no page-coupled DD
  // enrichment here.)

  // Upgrader winnings — sourced DIRECTLY from `upgrader_games`, the
  // canonical per-play record (also used by /transactions/upgrader and
  // the dashboard Upgrader Stats section). It carries `won_amount`
  // (0 on a loss, the gross payout on a win) keyed off the same
  // game_sessions row the bet ledger entry points at, so we can join
  // by game_session_id and get the outcome + multiplier per upgrader
  // bet without round-tripping through the ledger payout row.
  //
  // `game_sessions.game_id` is the upgrader_games row's UUID for
  // game_type='upgrader' — verified against analytics-packs.ts's same
  // convention for packs. The lookup itself was KICKED (not awaited) right
  // after `transactions` resolved above, so it has been running concurrently
  // with the battle lookup + inventory/voucher fan-out + battle-winnings
  // groupBy this whole time — this just joins that already-in-flight promise.
  const upgraderBetByLedgerId = await upgraderBetByLedgerIdPromise;
  const upgraderWinningsByGsid = new Map<string, number>();
  for (const r of upgraderBetByLedgerId.values()) {
    if (r.gsid && r.won_amount != null) {
      upgraderWinningsByGsid.set(r.gsid, toNumber(r.won_amount));
    }
  }

  // Instant-rakeback enrichment (see getUserFinancialTransactionsLight) —
  // flag the rakeback_claim rows on this page that were early-claimed.
  // Drift-safe + best-effort: failures leave the plain "Rakeback" label.
  let instantRakebackIds = new Set<string>();
  const rakebackLedgerIds = transactions
    .filter((t) => t.type === "rakeback_claim")
    .map((t) => t.id);
  if (rakebackLedgerIds.length > 0) {
    try {
      instantRakebackIds = await getInstantRakebackLedgerTxIds(
        rakebackLedgerIds,
      );
    } catch (e) {
      console.error(
        "[getUserTransactions] instant-rakeback lookup failed (non-fatal):",
        e,
      );
    }
  }

  const data: Transaction[] = transactions.map((t) => {
      const gs = t.game_sessions_ledger_transactions_game_session_idTogame_sessions;
      const pack = gs?.game_type === "pack" && gs.game_id ? packByGameId.get(gs.game_id) ?? null : null;
      const meta = t.metadata as Record<string, unknown> | null;
      const invItemId = meta?.inventory_item_id as string | undefined;
      const soldItem = invItemId ? inventoryMap.get(invItemId) ?? null : null;

      // Borrow extraction — same convention used by getTransactions
      // and getLiveActivity. Battle rows read borrow_percentage off
      // the linked battle; solo rows read it off the first PF
      // result's metadata. All PF results in a session share the
      // same borrow setting.
      let borrowPercentage: number | null = null;
      let borrowedAmountUsd: number | null = null;
      if (gs) {
        const firstPf = gs.provably_fair_results[0];
        // A PENDING battle (animating/in_progress) has no provably_fair_results
        // rows yet (they're inserted round-by-round at resolution), so the
        // PF-based lookup below would miss the borrow %. The battle is still
        // linked via battle_participants, whose battle_id carries the same
        // borrow_percentage, so resolve off it first. This makes the borrow
        // badge render identically on pending and settled battle rows.
        const participantBattleId = gs.battle_participants?.battle_id ?? null;
        if (firstPf?.battle_id) {
          borrowPercentage = battleBorrowMap.get(firstPf.battle_id) ?? null;
        } else if (participantBattleId) {
          borrowPercentage = battleBorrowMap.get(participantBattleId) ?? null;
        } else if (firstPf) {
          const m = firstPf.result_metadata as Record<string, unknown> | null;
          const raw = m?.borrow_percentage;
          if (typeof raw === "number") borrowPercentage = raw;
          else if (typeof raw === "string") {
            const n = parseInt(raw, 10);
            borrowPercentage = Number.isFinite(n) ? n : null;
          }
        }
        if (borrowPercentage != null && borrowPercentage > 0) {
          const cost = toNumber(gs.bet_amount);
          if (cost > 0) borrowedAmountUsd = cost * (borrowPercentage / 100);
        }
      }

      // Battle id for the "watch live" link (packy.gg/games/battles/<id>).
      // This is the `battles` row id — NOT the game_session_id. Source of
      // truth: the session's one-to-one battle_participants.battle_id (FK
      // chain game_session → battle_participants → battles). PF result +
      // ledger metadata are best-effort fallbacks only. Null on non-battle
      // rows (battle_participants is null for solo/pack sessions).
      const battleId =
        gs?.battle_participants?.battle_id ??
        gs?.provably_fair_results[0]?.battle_id ??
        (typeof meta?.battle_id === "string" ? (meta.battle_id as string) : null) ??
        null;

      // Sponsorship % of the linked battle (0 = none, 100 = fully
      // sponsored). Null on non-battle rows so the badge only shows on
      // battle activity.
      const sponsorshipPercentage = battleId
        ? (battleSponsorshipMap.get(battleId) ?? null)
        : null;

      // Raw battle-mode enum string for the linked battle (the
      // transaction-detail modal maps it to a readable label and appends
      // any borrow/sponsorship modifier). Null on non-battle rows.
      const battleMode = battleId
        ? (battleModeMap.get(battleId) ?? null)
        : null;

      // Is the linked battle still running (outcome not locked yet)?
      // Pending = the live in-flight states ONLY (`animating` /
      // `in_progress`); `waiting` (queued), `completed` and `cancelled`
      // (settled) are NOT pending. Reuses the already-fetched
      // battles.status from battleOutcomeMap — no extra query. Null on
      // non-battle rows (or when the battle row couldn't be fetched).
      const battleStatus = battleId
        ? (battleOutcomeMap.get(battleId)?.status ?? null)
        : null;
      const battlePending =
        battleStatus == null
          ? null
          : battleStatus === "animating" || battleStatus === "in_progress";

      // Boolean flag — does the linked battle have a password set?
      // Drives the "Copy Watch URL w/ password" affordance on the
      // gaming-tab Watch button + the password reveal row in the
      // transaction-detail modal. The plaintext is NEVER returned here
      // (see battleHasPasswordMap comment above); admins call
      // revealBattlePassword on demand and that audit-logs each view.
      // Null on non-battle rows so non-battle UIs can skip the check.
      const hasPassword = battleId
        ? (battleHasPasswordMap.get(battleId) ?? false)
        : null;

      // Battle outcome + winnings for a battle_bet row.
      //   battleResult: "win" | "lose" | null (null = not resolved yet —
      //     in_progress / animating / waiting / cancelled). Decided by
      //     battles.winner_team vs this user's team_number.
      //   battleWinnings: the user's realized take (their battle-sourced
      //     inventory for this game_session). 0 on a loss; >0 on a win
      //     with kept cards; null when not a resolved battle_bet.
      let battleResult: "win" | "lose" | null = null;
      let battleWinnings: number | null = null;
      // Win/loss DIRECTION for a PENDING battle_bet (battle status
      // animating / in_progress) — derived from battles.winner_team vs the
      // user's team_number, the IDENTICAL comparison the settled
      // battleResult uses. Only the direction is surfaced; the exact dollar
      // AMOUNT is intentionally NOT derivable while pending and stays
      // hidden ("resolving"). Null when not pending, or when winner_team is
      // not yet materialized (in_progress can be null) → no fabricated side.
      let battleOutcomePending: "win" | "loss" | null = null;
      if (t.type === "battle_bet") {
        const outcome = battleId ? battleOutcomeMap.get(battleId) : null;
        const userTeam = gs?.battle_participants?.team_number ?? null;
        if (
          outcome &&
          outcome.status === "completed" &&
          outcome.winnerTeam != null &&
          userTeam != null
        ) {
          const won = userTeam === outcome.winnerTeam;
          battleResult = won ? "win" : "lose";
          battleWinnings = won
            ? t.game_session_id
              ? battleWinningsByGsid.get(t.game_session_id) ?? 0
              : 0
            : 0;
        }
        const isPending =
          outcome != null &&
          (outcome.status === "animating" || outcome.status === "in_progress");
        if (isPending && outcome.winnerTeam != null && userTeam != null) {
          battleOutcomePending =
            userTeam === outcome.winnerTeam ? "win" : "loss";
        }
      }

      // Upgrader outcome — look up the upgrader_games row for this
      // upgrader_bet via its game_session_id. `won_amount > 0` = win
      // (with that value as the user's take); `won_amount = 0` = loss.
      // upgraderWinningsByGsid was populated above from the
      // game_sessions → upgrader_games join.
      let upgraderResult: "win" | "lose" | null = null;
      let upgraderWinnings: number | null = null;
      // Configuration the user picked before the spin — parsed
      // defensively from the first PF row's result_metadata blob. The
      // blob shape isn't pinned by the backend (see
      // upgrader-metadata.ts notes), so missing keys come back as null
      // and the UI renders "—". Already-loaded PF rows are reused
      // (no extra query).
      let upgraderTargetMultiplier: number | null = null;
      let upgraderTargetChance: number | null = null;
      let upgraderTargetChanceDerived: boolean | null = null;
      let upgraderHouseEdge: number | null = null;
      if (t.type === "upgrader_bet") {
        const upgraderRow = upgraderBetByLedgerId.get(t.id);
        const resolvedGsid =
          t.game_session_id ?? upgraderRow?.gsid ?? null;
        const won =
          resolvedGsid != null
            ? upgraderWinningsByGsid.get(resolvedGsid)
            : upgraderRow?.won_amount != null
              ? toNumber(upgraderRow.won_amount)
              : undefined;
        if (won !== undefined && won > 0) {
          upgraderResult = "win";
          upgraderWinnings = won;
        } else if (won !== undefined) {
          upgraderResult = "lose";
          upgraderWinnings = 0;
        }
        const pfMetadataSources = [
          ...(gs?.provably_fair_results ?? []).map((pf) => pf.result_metadata),
          t.metadata,
        ];
        const resolved = resolveUpgraderTargetFromBatch(
          upgraderRow,
          ...pfMetadataSources,
        );
        upgraderTargetMultiplier = resolved.targetMultiplier;
        upgraderTargetChance = resolved.targetChance;
        upgraderTargetChanceDerived = resolved.targetChanceDerived;
        upgraderHouseEdge = resolved.houseEdge;
      }

      // Total worth (cash balance + held inventory) before/after this tx,
      // so a battle/pack that trades cash for items reads as the true
      // total-worth change instead of a pure cash drop. Uses the two
      // sweep snapshots: "before" = inventory held strictly before this
      // tx, "after" = inventory held at this tx (after any same-instant
      // items land). This is the single source for both the table row and
      // the detail modal, so the two surfaces never disagree.
      const balanceBeforeNum = toNumber(t.balance_before);
      const balanceAfterNum = toNumber(t.balance_after);
      // Held inventory can never be negative; clamp tiny floating-point
      // residue from the +/- sweep (e.g. 359.96 − 359.96 = -1e-13) to 0
      // so it never renders as "-$0.00".
      const inventoryValueNum = Math.max(0, inventoryValueByTx.get(t.id) ?? 0);
      const inventoryValueBeforeNum = Math.max(
        0,
        inventoryValueBeforeByTx.get(t.id) ?? 0,
      );
      const cardsValueNum = cardsValueByTx.has(t.id)
        ? cardsValueByTx.get(t.id)!
        : null;

      // A WON battle pays out in CARDS that land at battle resolution —
      // LATER than this bet row's timestamp — so the bet row's inventory
      // snapshot (taken at battle start) doesn't include them, which made
      // a winning battle look like a pure cash loss with $0 inventory.
      // Reflect the battle's OUTCOME on its bet row: show the won cards in
      // this row's inventory and worth. Built from the strictly-before
      // snapshot + winnings so it never double-counts (the won cards are
      // always obtained after the bet, never in the before snapshot).
      const isWonBattleBet =
        t.type === "battle_bet" &&
        battleResult === "win" &&
        battleWinnings != null &&
        battleWinnings > 0;
      const inventoryDisplayedNum = isWonBattleBet
        ? inventoryValueBeforeNum + battleWinnings!
        : inventoryValueNum;

      return {
        id: t.id,
        type: t.type,
        amount: toNumber(t.amount),
        balanceBefore: balanceBeforeNum,
        balanceAfter: balanceAfterNum,
        worthBefore: balanceBeforeNum + inventoryValueBeforeNum,
        worthAfter: balanceAfterNum + inventoryDisplayedNum,
        description: t.description,
        status: t.status,
        gameSessionId: t.game_session_id,
        packId: pack?.id ?? null,
        packName: pack?.name ?? null,
        cardsValue: cardsValueNum,
        // For battles, the win/lose signal is the battle outcome
        // (winner_team vs team_number), NOT game_sessions.result. Packs
        // keep gs.result (unused by the UI, but harmless).
        gameResult: t.type === "battle_bet" ? battleResult : gs?.result ?? null,
        inventoryValue: inventoryDisplayedNum,
        soldCard: soldItem?.card ? {
          name: soldItem.card.name,
          imageUrl: soldItem.card.image_url,
          rarity: soldItem.card.rarity,
        } : null,
        cryptoAsset: t.crypto_asset,
        cryptoAmount: t.crypto_amount ? toNumber(t.crypto_amount) : null,
        exchangeRate: t.exchange_rate ? toNumber(t.exchange_rate) : null,
        blockchainTxHash: t.blockchain_tx_hash,
        sourceAddress: t.source_address,
        destinationAddress: t.destination_address,
        depositAddressId: t.deposit_address_id,
        failureReason: t.failure_reason,
        metadata: t.metadata ? JSON.parse(JSON.stringify(t.metadata)) : null,
        fireblocksTxId: t.fireblocks_tx_id,
        externalTxId: t.external_tx_id,
        createdAt: t.created_at.toISOString(),
        updatedAt: t.updated_at.toISOString(),
        borrowPercentage,
        borrowedAmountUsd,
        sponsorshipPercentage,
        battleId,
        battleMode,
        battlePending,
        hasPassword,
        battleWinnings,
        battleOutcomePending,
        upgraderResult,
        upgraderWinnings,
        upgraderTargetMultiplier,
        upgraderTargetChance,
        upgraderTargetChanceDerived,
        upgraderHouseEdge,
        // Real ledger rows are never a synthetic double-down; the double-down
        // is surfaced as its OWN synthesized row (injected below), so these
        // fields are null on every real row.
        syntheticKind: null,
        doubleDownResult: null,
        doubleDownAmount: null,
        isInstantRakeback:
          t.type === "rakeback_claim"
            ? instantRakebackIds.has(t.id)
            : null,
      };
    });

  // ── Merge decoupled DOUBLE-DOWN rows into the paginated feed ───────────
  // `data` currently holds the OVER-FETCHED ledger window (rows at global
  // ledger positions [fetchSkip, fetchSkip + data.length), desc by
  // created_at). We now merge the user's synthetic double-down rows
  // (ddSynthetic, all of them, desc by resolved_at — read decoupled up-front)
  // into the full desc-by-time timeline and return exactly the requested
  // page's slice.
  //
  // Correct pagination WITHOUT fetching every ledger row: assign each row a
  // GLOBAL merged position, then keep only the rows whose position falls in
  // [rawOffset, rawOffset + perPage).
  //   • A ledger row's global MERGED position = (its known global ledger rank)
  //     + (number of DD rows strictly newer than it). Its ledger rank is
  //     fetchSkip + its index in the desc window.
  //   • A DD row's global MERGED position = (number of ledger rows strictly
  //     newer than it) + (number of DD rows strictly newer than it). The
  //     ledger-newer count per DD row is computed in ONE grouped query
  //     (ddPrecedingLedger) so we never scan the whole ledger.
  // Ties (equal timestamp) are broken deterministically: a DD row sorts
  // ABOVE (newer than) a ledger row at the same instant, because a round
  // resolves after — and is surfaced just above — its battle bet.
  const ddPrecedingLedger = await countLedgerNewerThanEach(
    db,
    where,
    ddSynthetic.map((d) => d.resolvedAt),
  );

  type Positioned = { pos: number; row: Transaction };
  const positioned: Positioned[] = [];

  // DD rows first so equal-timestamp ties resolve DD-above-ledger (a DD's
  // position counts only STRICTLY-newer ledger rows, so a same-instant ledger
  // row is NOT counted as newer → the DD lands above it).
  ddSynthetic.forEach((d, i) => {
    const ddNewer = ddSynthetic.filter(
      (o) => o.resolvedAt.getTime() > d.resolvedAt.getTime(),
    ).length;
    const pos = (ddPrecedingLedger[i] ?? 0) + ddNewer;
    positioned.push({ pos, row: buildDoubleDownRow(d) });
  });

  // Ledger rows: known global ledger rank + DD rows strictly newer than it.
  data.forEach((row, i) => {
    const ledgerRank = fetchSkip + i;
    const rowTs = new Date(row.createdAt).getTime();
    const ddNewer = ddSynthetic.filter(
      (o) => o.resolvedAt.getTime() > rowTs,
    ).length;
    positioned.push({ pos: ledgerRank + ddNewer, row });
  });

  positioned.sort((a, b) => a.pos - b.pos);
  const pageRows = positioned
    .filter((p) => p.pos >= rawOffset && p.pos < rawOffset + perPage)
    .map((p) => p.row);

  const total = ledgerTotal + ddTotal;
  return {
    data: pageRows,
    total,
    page,
    perPage,
    totalPages: Math.max(1, Math.ceil(total / perPage)),
  };
}
