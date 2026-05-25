import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { Prisma } from "@/generated/prisma/client";

export async function getUserTransactions(
  userId: string,
  page: number = 1,
  perPage: number = 20,
  filters?: { type?: string; types?: string[]; status?: string; dateFrom?: string; dateTo?: string }
) {
  const db = await getDb();
  const where: Prisma.ledger_transactionsWhereInput = { user_id: userId };

  if (filters?.type && filters.type !== "all") {
    where.type = filters.type as Prisma.Enumledger_transaction_typeFilter["equals"];
  } else if (filters?.types && filters.types.length > 0) {
    where.type = { in: filters.types as Prisma.Enumledger_transaction_typeFilter["in"] };
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
            // authoritative id for the "watch live" link.
            battle_participants: { select: { battle_id: true } },
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

  // Batch-fetch battles.borrow_percentage for any battle-linked PF
  // results so the user-detail tab can render the same BorrowBadge
  // as the global transactions list / live feed.
  //
  // CRITICAL: auxiliary lookup — same convention as getTransactions.
  // A failure here must NOT take down the whole /users/[id] activity
  // tab. Wrap in try/catch; on failure, badge is just absent for the
  // page-load and rows still render.
  const battleIdsForBorrow = new Set<string>();
  for (const t of transactions) {
    const gs = t.game_sessions_ledger_transactions_game_session_idTogame_sessions;
    for (const pf of gs?.provably_fair_results ?? []) {
      if (pf.battle_id) battleIdsForBorrow.add(pf.battle_id);
    }
  }
  const battleBorrowMap = new Map<string, number>();
  if (battleIdsForBorrow.size > 0) {
    try {
      const battlesForBorrow = await db.battles.findMany({
        where: { id: { in: [...battleIdsForBorrow] } },
        select: { id: true, borrow_percentage: true },
      });
      for (const b of battlesForBorrow) {
        battleBorrowMap.set(b.id, b.borrow_percentage ?? 0);
      }
    } catch (e) {
      console.error(
        "[getUserTransactions] battle borrow lookup failed (non-fatal):",
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
          user_id: userId,
          ...(maxTxTs ? { obtained_at: { lte: maxTxTs } } : {}),
        },
        select: { value_at_obtained: true, obtained_at: true, sold_at: true, exchanged_at: true },
      }),
      // Vouchers are held value too — battle / exchange excess gets
      // parked as a voucher until the user redeems it. Pulled so the
      // per-tx held-value snapshot can count them alongside cards.
      db.vouchers.findMany({
        where: { user_id: userId },
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
    const sold = item.sold_at ? item.sold_at.getTime() : null;
    const exchanged = item.exchanged_at ? item.exchanged_at.getTime() : null;
    let disposed: number | null = null;
    if (sold !== null && exchanged !== null) disposed = Math.min(sold, exchanged);
    else if (sold !== null) disposed = sold;
    else if (exchanged !== null) disposed = exchanged;
    if (disposed !== null) sweepEvents.push({ t: disposed, d: -value });
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

  // ── Battle winnings (for WON battle_bet rows) ─────────────────────
  // A battle is winner-takes-all: the winner walks away with EVERY card
  // pulled across ALL participants. So a winner's payout = the battle's
  // total card value, and a loser's payout = 0. This is the authoritative
  // battle-economics definition used by the battles list/detail
  // (src/lib/queries/battles.ts) — we mirror its exact SQL here rather
  // than invent a separate mechanism, so the per-row P&L on the user tab
  // matches what the battle pages show.
  //
  // total_card_value = SUM over all participants' PF results of
  // (user_inventory.value_at_obtained, falling back to cards.price when
  // the card never landed in the winner's inventory) — joined
  // battles → battle_participants → game_sessions → provably_fair_results
  // → user_inventory, with a card-price fallback via result_metadata.
  const wonBattleIds = new Set<string>();
  for (const t of transactions) {
    if (t.type !== "battle_bet") continue;
    const gs = t.game_sessions_ledger_transactions_game_session_idTogame_sessions;
    if (gs?.result !== "win") continue;
    const bId =
      gs?.battle_participants?.battle_id ??
      gs?.provably_fair_results[0]?.battle_id ??
      null;
    if (bId) wonBattleIds.add(bId);
  }

  const battleWinningsById = new Map<string, number>();
  if (wonBattleIds.size > 0) {
    try {
      const rows = await db.$queryRaw<
        { id: string; total_card_value: number }[]
      >`
        SELECT
          b.id::text AS id,
          COALESCE(
            SUM(COALESCE(ui.value_at_obtained::numeric, c.price::numeric, 0)),
            0
          )::float8 AS total_card_value
        FROM battles b
        LEFT JOIN battle_participants bp ON bp.battle_id = b.id
        LEFT JOIN game_sessions gs ON gs.id = bp.game_session_id
        LEFT JOIN provably_fair_results pf ON pf.game_session_id = gs.id
        LEFT JOIN user_inventory ui ON ui.id = pf.inventory_item_id
        LEFT JOIN cards c ON c.id::text = pf.result_metadata->>'card_id'
        WHERE b.id::text IN (${Prisma.join([...wonBattleIds])})
        GROUP BY b.id
      `;
      for (const r of rows) {
        battleWinningsById.set(r.id, r.total_card_value);
      }
    } catch (e) {
      console.error(
        "[getUserTransactions] battle winnings (card value) lookup failed (non-fatal):",
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
        if (firstPf?.battle_id) {
          borrowPercentage = battleBorrowMap.get(firstPf.battle_id) ?? null;
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

      // Winnings for a battle_bet row (winner-takes-all card value).
      //   0    → resolved LOSS (won nothing; house keeps the full bet)
      //   >0   → resolved WIN; the battle's total card value (what the
      //          winner walked away with across all participants)
      //   null → not a resolved battle_bet, or a win whose battle id
      //          couldn't be derived (UI shows an outcome label, not a
      //          fabricated number).
      let battleWinnings: number | null = null;
      if (t.type === "battle_bet") {
        const result = gs?.result ?? null;
        if (result === "lose") {
          battleWinnings = 0;
        } else if (result === "win") {
          battleWinnings =
            battleId && battleWinningsById.has(battleId)
              ? battleWinningsById.get(battleId)!
              : null;
        }
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
      const inventoryValueNum = inventoryValueByTx.get(t.id) ?? 0;
      const inventoryValueBeforeNum = inventoryValueBeforeByTx.get(t.id) ?? 0;
      const cardsValueNum = cardsValueByTx.has(t.id)
        ? cardsValueByTx.get(t.id)!
        : null;

      return {
        id: t.id,
        type: t.type,
        amount: toNumber(t.amount),
        balanceBefore: balanceBeforeNum,
        balanceAfter: balanceAfterNum,
        worthBefore: balanceBeforeNum + inventoryValueBeforeNum,
        worthAfter: balanceAfterNum + inventoryValueNum,
        description: t.description,
        status: t.status,
        gameSessionId: t.game_session_id,
        packId: pack?.id ?? null,
        packName: pack?.name ?? null,
        cardsValue: cardsValueNum,
        gameResult: gs?.result ?? null, // "win" | "lose" | null (null = still resolving)
        inventoryValue: inventoryValueNum,
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
        battleId,
        battleWinnings,
      };
    }),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}
