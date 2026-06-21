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
import type { ledger_transaction_type } from "@/generated/prisma/enums";

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

export async function getUserTransactions(
  userId: string,
  page: number = 1,
  perPage: number = 20,
  filters?: { type?: string; types?: string[]; status?: string; dateFrom?: string; dateTo?: string }
) {
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
  try {
    const session = await verifySession();
    viewerIsOwner = await isAdjustmentVisibilityOwner(session.userId);
  } catch {
    // No resolvable session → fail closed (hide adjustments). This path is
    // not expected: every caller runs inside an authenticated admin request.
    viewerIsOwner = false;
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

  const [transactions, total] = await Promise.all([
    db.ledger_transactions.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
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
  }

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
  // convention for packs.
  const upgraderBetLedgerIds = transactions
    .filter((t) => t.type === "upgrader_bet")
    .map((t) => t.id);
  const upgraderBetByLedgerId = await fetchUpgraderTargetByLedgerTxIds(
    db,
    upgraderBetLedgerIds,
  );
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

  return {
    data: transactions.map((t) => {
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
        isInstantRakeback:
          t.type === "rakeback_claim"
            ? instantRakebackIds.has(t.id)
            : null,
      };
    }),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}
