import { db } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import type { PaginatedResult } from "@/lib/types";
import { Prisma } from "@/generated/prisma/client";

export type TransactionListItem = {
  id: string;
  userId: string;
  username: string | null;
  type: string;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  status: string;
  description: string;
  createdAt: string;
  houseEdge: number | null;
  payout: number | null;
};

export async function getTransactions(params: {
  page?: number;
  perPage?: number;
  search?: string;
  type?: string;
  types?: string[];
  status?: string;
  minAmount?: number;
  maxAmount?: number;
}): Promise<PaginatedResult<TransactionListItem>> {
  const { page = 1, perPage = 20, search, type, types, status, minAmount, maxAmount } = params;

  const where: Prisma.ledger_transactionsWhereInput = {};

  if (search) {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(search);
    where.OR = [
      ...(isUuid ? [{ id: search }, { user_id: search }, { metadata: { path: ["battle_id"], equals: search } }] : []),
      { user: { username: { contains: search, mode: "insensitive" as const } } },
    ];
  }

  if (types && types.length > 0) {
    where.type = { in: types } as unknown as Prisma.Enumledger_transaction_typeFieldUpdateOperationsInput["set"];
  } else if (type && type !== "all") {
    where.type = type as Prisma.Enumledger_transaction_typeFieldUpdateOperationsInput["set"];
  }

  if (status && status !== "all") {
    where.status = status as Prisma.Enumledger_transaction_statusFieldUpdateOperationsInput["set"];
  }

  if (minAmount !== undefined || maxAmount !== undefined) {
    where.amount = {
      ...(minAmount !== undefined ? { gte: minAmount } : {}),
      ...(maxAmount !== undefined ? { lte: maxAmount } : {}),
    };
  }

  const [transactions, total] = await Promise.all([
    db.ledger_transactions.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
      include: {
        user: { select: { username: true } },
        game_sessions_ledger_transactions_game_session_idTogame_sessions: {
          select: {
            bet_amount: true,
            provably_fair_results: {
              select: {
                user_inventory: { select: { value_at_obtained: true } },
              },
            },
          },
        },
      },
    }),
    db.ledger_transactions.count({ where }),
  ]);

  return {
    data: transactions.map((t) => {
      const gs = t.game_sessions_ledger_transactions_game_session_idTogame_sessions;
      let houseEdge: number | null = null;
      let payout: number | null = null;
      if (gs) {
        const cost = toNumber(gs.bet_amount);
        payout = gs.provably_fair_results.reduce(
          (sum, pf) => sum + (pf.user_inventory ? toNumber(pf.user_inventory.value_at_obtained) : 0),
          0
        );
        if (cost > 0) {
          houseEdge = ((cost - payout) / cost) * 100;
        }
      }
      const balanceBefore = toNumber(t.balance_before);
      const balanceAfter = toNumber(t.balance_after);
      return {
        id: t.id,
        userId: t.user_id,
        username: t.user?.username ?? null,
        type: t.type,
        amount: balanceAfter - balanceBefore,
        balanceBefore,
        balanceAfter,
        status: t.status,
        description: t.description,
        createdAt: t.created_at.toISOString(),
        houseEdge,
        payout,
      };
    }),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}

export async function getTransactionDetail(id: string) {
  const tx = await db.ledger_transactions.findUnique({
    where: { id },
    include: {
      user: { select: { username: true, email: true } },
    },
  });

  if (!tx) return null;

  const balanceBefore = toNumber(tx.balance_before);
  const balanceAfter = toNumber(tx.balance_after);
  // Derive the actual signed amount from balance change
  const amount = balanceAfter - balanceBefore;

  // If this tx is linked to a game session, fetch cards obtained
  let gameSession: {
    gameType: string;
    betAmount: number;
    houseEdge: number | null;
    packs: { name: string; imageUrl: string | null; priceUsd: number; quantity: number }[];
    cardsObtained: {
      name: string;
      imageUrl: string | null;
      rarity: string | null;
      valueAtObtained: number;
      currentPriceUsd: number;
    }[];
    relatedTransactions: {
      id: string;
      type: string;
      amount: number;
      description: string;
    }[];
  } | null = null;

  if (tx.game_session_id) {
    const session = await db.game_sessions.findUnique({
      where: { id: tx.game_session_id },
      include: {
        provably_fair_results: {
          include: {
            user_inventory: {
              select: { card_id: true, value_at_obtained: true },
            },
          },
        },
      },
    });

    if (session) {
      // Fetch pack info based on game type
      let packs: { name: string; imageUrl: string | null; priceUsd: number; quantity: number }[] = [];

      if (session.game_type === "pack") {
        const pack = await db.packs.findUnique({
          where: { id: session.game_id },
          select: { name: true, image_url: true, price: true, cards_per_open: true },
        });
        if (pack) {
          const cardsCount = session.provably_fair_results.length;
          const packsOpened = pack.cards_per_open > 0 ? Math.round(cardsCount / pack.cards_per_open) : 1;
          packs = [{ name: pack.name, imageUrl: pack.image_url, priceUsd: toNumber(pack.price), quantity: packsOpened }];
        }
      } else if (session.game_type === "battle") {
        const battle = await db.battles.findUnique({
          where: { id: session.game_id },
          select: { pack_ids: true, bet_amount: true },
        });
        if (battle && battle.pack_ids.length > 0) {
          const battlePacks = await db.packs.findMany({
            where: { id: { in: battle.pack_ids } },
            select: { name: true, image_url: true, price: true },
          });
          packs = battlePacks.map((p) => ({
            name: p.name,
            imageUrl: p.image_url,
            priceUsd: toNumber(p.price),
            quantity: 1,
          }));
        }
      }

      // Fetch cards from inventory items
      const cardIds = session.provably_fair_results
        .map((pf) => pf.user_inventory?.card_id)
        .filter((cid): cid is string => !!cid);

      const cards = cardIds.length > 0
        ? await db.cards.findMany({
            where: { id: { in: cardIds } },
            select: { id: true, name: true, image_url: true, rarity: true, price: true },
          })
        : [];

      const cardsMap = new Map(cards.map((c) => [c.id, c]));

      // Fetch all ledger transactions linked to this game session
      const relatedTxs = await db.ledger_transactions.findMany({
        where: { game_session_id: tx.game_session_id! },
        orderBy: { created_at: "asc" },
        select: { id: true, type: true, amount: true, balance_before: true, balance_after: true, description: true },
      });

      const betAmount = toNumber(session.bet_amount);
      const totalPayout = session.provably_fair_results
        .filter((pf) => pf.user_inventory?.card_id && cardsMap.has(pf.user_inventory.card_id))
        .reduce((sum, pf) => sum + toNumber(pf.user_inventory!.value_at_obtained), 0);
      const houseEdge = betAmount > 0 ? ((betAmount - totalPayout) / betAmount) * 100 : null;

      gameSession = {
        gameType: session.game_type,
        betAmount,
        houseEdge,
        packs,
        cardsObtained: session.provably_fair_results
          .filter((pf) => pf.user_inventory?.card_id && cardsMap.has(pf.user_inventory.card_id))
          .map((pf) => {
            const card = cardsMap.get(pf.user_inventory!.card_id)!;
            return {
              name: card.name,
              imageUrl: card.image_url,
              rarity: card.rarity,
              valueAtObtained: toNumber(pf.user_inventory!.value_at_obtained),
              currentPriceUsd: toNumber(card.price),
            };
          }),
        relatedTransactions: relatedTxs.map((rt) => ({
          id: rt.id,
          type: rt.type,
          amount: toNumber(rt.balance_after) - toNumber(rt.balance_before),
          description: rt.description,
        })),
      };
    }
  }

  return {
    id: tx.id,
    userId: tx.user_id,
    username: tx.user?.username ?? null,
    email: tx.user?.email ?? null,
    type: tx.type,
    amount,
    balanceBefore,
    balanceAfter,
    gameSessionId: tx.game_session_id,
    gameSession,
    cryptoAsset: tx.crypto_asset,
    cryptoAmount: tx.crypto_amount ? toNumber(tx.crypto_amount) : null,
    exchangeRate: tx.exchange_rate ? toNumber(tx.exchange_rate) : null,
    blockchainTxHash: tx.blockchain_tx_hash,
    sourceAddress: tx.source_address,
    destinationAddress: tx.destination_address,
    status: tx.status,
    failureReason: tx.failure_reason,
    description: tx.description,
    metadata: tx.metadata,
    createdAt: tx.created_at.toISOString(),
    updatedAt: tx.updated_at.toISOString(),
  };
}
