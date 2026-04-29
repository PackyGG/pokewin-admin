import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import type { PaginatedResult } from "@/lib/types";
import { Prisma } from "@/generated/prisma/client";

export type TransactionListItem = {
  id: string;
  userId: string;
  username: string | null;
  image: string | null;
  type: string;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  status: string;
  description: string;
  createdAt: string;
  houseEdge: number | null;
  payout: number | null;
  cryptoAsset: string | null;
  cryptoAmount: number | null;
  // Set by mergeDepositBonuses() when a deposit_bonus ledger row has been
  // folded into its parent deposit row. Null means no merged bonus.
  bonusAmount: number | null;
};

/**
 * Paginated query specifically for the Deposits & Withdrawals view.
 *
 * Why a separate raw SQL query instead of reusing getTransactions + a
 * post-query merge: on the deposits view, each logical "deposit" may be
 * stored as two ledger rows (a `deposit` + a `deposit_bonus`). We want a
 * single merged row per logical deposit. Doing the merge AFTER a normal
 * `findMany` would return fewer rows per page than requested (because we'd
 * drop merged bonus rows after pagination). Doing it in SQL keeps the page
 * size exact and handles page-boundary edge cases correctly.
 *
 * Pairing rule (verified against real sample data — not guessed):
 *   - same user_id
 *   - bonus.balance_before exactly equals deposit.balance_after
 *   - bonus.created_at is within 2 minutes after deposit.created_at
 * The ledger is sequential per user and the bonus fires right after its
 * deposit with no intervening row, so balance continuity is a deterministic
 * link. Orphan `deposit_bonus` rows (e.g. manual admin bonus with no parent
 * deposit) are still returned as their own row.
 *
 * Filters supported: search (UUID or username), status.
 */
export async function getDepositTransactions(params: {
  page?: number;
  perPage?: number;
  search?: string;
  status?: string;
}): Promise<PaginatedResult<TransactionListItem>> {
  const {
    page = 1,
    perPage = 20,
    search,
    status,
  } = params;
  const db = await getDb();
  const safePerPage = Math.max(1, Math.min(200, Math.floor(perPage)));
  const safePage = Math.max(1, Math.floor(page));
  const offset = (safePage - 1) * safePerPage;

  // Bind user-provided values via positional parameters to avoid SQL injection.
  const queryParams: unknown[] = [];
  let searchFilter = "";
  if (search) {
    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        search
      );
    if (isUuid) {
      queryParams.push(search);
      const idx = queryParams.length;
      searchFilter = `AND (t.id::text = $${idx} OR t.user_id = $${idx})`;
    } else {
      queryParams.push(`%${search.toLowerCase()}%`);
      const idx = queryParams.length;
      searchFilter = `AND LOWER(u.username) LIKE $${idx}`;
    }
  }

  // Status is a whitelisted enum — safe to inline after validation.
  const VALID_STATUSES = new Set(["pending", "completed", "failed"]);
  const statusFilter =
    status && VALID_STATUSES.has(status)
      ? `AND t.status = '${status}'`
      : "";

  // Exclude bonus rows that are paired with a deposit already in the set.
  // This keeps page sizes exact and avoids showing the bonus twice (once
  // merged into its deposit, once as its own row).
  const bonusPairedExclusion = `
    AND NOT (
      t.type = 'deposit_bonus'
      AND EXISTS (
        SELECT 1 FROM ledger_transactions d
        WHERE d.user_id = t.user_id
          AND d.type = 'deposit'
          AND d.balance_after = t.balance_before
          AND d.created_at <= t.created_at
          AND d.created_at > t.created_at - INTERVAL '2 minutes'
      )
    )
  `;

  const baseWhere = `
    WHERE t.type IN ('deposit', 'deposit_bonus', 'withdrawal_shipping_fee')
      ${searchFilter}
      ${statusFilter}
      ${bonusPairedExclusion}
  `;

  const countSql = `
    SELECT COUNT(*)::text AS total
    FROM ledger_transactions t
    LEFT JOIN "user" u ON u.id = t.user_id
    ${baseWhere}
  `;

  const dataSql = `
    SELECT
      t.id,
      t.user_id,
      u.username,
      u.image,
      t.type::text AS type,
      t.balance_before::text AS balance_before,
      t.balance_after::text AS balance_after,
      t.status::text AS status,
      t.description,
      t.created_at,
      t.crypto_asset,
      t.crypto_amount::text AS crypto_amount,
      b.amount::text AS bonus_amount,
      b.balance_after::text AS bonus_balance_after
    FROM ledger_transactions t
    LEFT JOIN "user" u ON u.id = t.user_id
    LEFT JOIN LATERAL (
      SELECT amount, balance_after
      FROM ledger_transactions
      WHERE user_id = t.user_id
        AND type = 'deposit_bonus'
        AND balance_before = t.balance_after
        AND created_at >= t.created_at
        AND created_at < t.created_at + INTERVAL '2 minutes'
      ORDER BY created_at ASC
      LIMIT 1
    ) b ON t.type = 'deposit'
    ${baseWhere}
    ORDER BY t.created_at DESC
    LIMIT ${safePerPage}
    OFFSET ${offset}
  `;

  type Raw = {
    id: string;
    user_id: string;
    username: string | null;
    image: string | null;
    type: string;
    balance_before: string;
    balance_after: string;
    status: string;
    description: string;
    created_at: Date;
    crypto_asset: string | null;
    crypto_amount: string | null;
    bonus_amount: string | null;
    bonus_balance_after: string | null;
  };

  const [countResult, rows] = await Promise.all([
    db.$queryRawUnsafe<{ total: string }[]>(countSql, ...queryParams),
    db.$queryRawUnsafe<Raw[]>(dataSql, ...queryParams),
  ]);

  const total = Number(countResult[0]?.total ?? "0");

  const data: TransactionListItem[] = rows.map((r) => {
    const balanceBefore = Number(r.balance_before);
    const rawBalanceAfter = Number(r.balance_after);
    const bonusAmount = r.bonus_amount != null ? Number(r.bonus_amount) : null;
    // When a bonus is attached, surface the post-bonus balance as the row's
    // final balance so the After column reflects the combined deposit+bonus.
    const finalBalanceAfter =
      bonusAmount != null && r.bonus_balance_after != null
        ? Number(r.bonus_balance_after)
        : rawBalanceAfter;
    return {
      id: r.id,
      userId: r.user_id,
      username: r.username,
      image: r.image,
      type: r.type,
      amount: finalBalanceAfter - balanceBefore,
      balanceBefore,
      balanceAfter: finalBalanceAfter,
      status: r.status,
      description: r.description,
      createdAt: r.created_at.toISOString(),
      // houseEdge/payout are game-session metrics — not applicable here.
      houseEdge: null,
      payout: null,
      cryptoAsset: r.crypto_asset,
      cryptoAmount: r.crypto_amount != null ? Number(r.crypto_amount) : null,
      bonusAmount,
    };
  });

  return {
    data,
    total,
    page: safePage,
    perPage: safePerPage,
    totalPages: Math.ceil(total / safePerPage),
  };
}

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
  const db = await getDb();

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

  // Narrow the ledger_transactions select for the list view: skip the
  // wide JSON `metadata` column plus blockchain/fireblocks/source/dest
  // columns that the table cells don't render. The page only renders the
  // fields below; everything else is detail-page concerns.
  const [transactions, total] = await Promise.all([
    db.ledger_transactions.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
      select: {
        id: true,
        user_id: true,
        type: true,
        balance_before: true,
        balance_after: true,
        status: true,
        description: true,
        created_at: true,
        crypto_asset: true,
        crypto_amount: true,
        user: { select: { username: true, image: true } },
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
        image: t.user?.image ?? null,
        type: t.type,
        amount: balanceAfter - balanceBefore,
        balanceBefore,
        balanceAfter,
        status: t.status,
        description: t.description,
        createdAt: t.created_at.toISOString(),
        houseEdge,
        payout,
        cryptoAsset: t.crypto_asset,
        cryptoAmount: t.crypto_amount ? toNumber(t.crypto_amount) : null,
        // Shared query doesn't pair deposit_bonus rows — only the
        // deposits-specific getDepositTransactions does that merging.
        bonusAmount: null,
      };
    }),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}

export async function getTransactionDetail(id: string) {
  const db = await getDb();
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
    // Narrow `provably_fair_results` columns to just what downstream uses.
    // The PF table is wide (client_seed, server_seed, server_seed_hash,
    // result_hash, ticket, result_metadata, etc.) but on this page we only
    // join through it to grab the linked inventory item.
    const session = await db.game_sessions.findUnique({
      where: { id: tx.game_session_id },
      select: {
        game_type: true,
        game_id: true,
        bet_amount: true,
        provably_fair_results: {
          select: {
            user_inventory: {
              select: { card_id: true, value_at_obtained: true },
            },
          },
        },
      },
    });

    if (session) {
      // Fetch pack info based on game type, card details, and related
      // transactions in parallel — they're independent.
      let packs: { name: string; imageUrl: string | null; priceUsd: number; quantity: number }[] = [];

      const cardIds = session.provably_fair_results
        .map((pf) => pf.user_inventory?.card_id)
        .filter((cid): cid is string => !!cid);

      const packsPromise =
        session.game_type === "pack"
          ? db.packs
              .findUnique({
                where: { id: session.game_id },
                select: { name: true, image_url: true, price: true, cards_per_open: true },
              })
              .then((pack) => {
                if (!pack) return [];
                const cardsCount = session.provably_fair_results.length;
                const packsOpened =
                  pack.cards_per_open > 0 ? Math.round(cardsCount / pack.cards_per_open) : 1;
                return [
                  {
                    name: pack.name,
                    imageUrl: pack.image_url,
                    priceUsd: toNumber(pack.price),
                    quantity: packsOpened,
                  },
                ];
              })
          : session.game_type === "battle"
          ? db.battles
              .findUnique({
                where: { id: session.game_id },
                select: { pack_ids: true, bet_amount: true },
              })
              .then(async (battle) => {
                if (!battle || battle.pack_ids.length === 0) return [];
                const battlePacks = await db.packs.findMany({
                  where: { id: { in: battle.pack_ids } },
                  select: { name: true, image_url: true, price: true },
                });
                return battlePacks.map((p) => ({
                  name: p.name,
                  imageUrl: p.image_url,
                  priceUsd: toNumber(p.price),
                  quantity: 1,
                }));
              })
          : Promise.resolve([] as { name: string; imageUrl: string | null; priceUsd: number; quantity: number }[]);

      const cardsPromise =
        cardIds.length > 0
          ? db.cards.findMany({
              where: { id: { in: cardIds } },
              select: { id: true, name: true, image_url: true, rarity: true, price: true },
            })
          : Promise.resolve([] as Array<{ id: string; name: string; image_url: string | null; rarity: string | null; price: unknown }>);

      const relatedTxsPromise = db.ledger_transactions.findMany({
        where: { game_session_id: tx.game_session_id! },
        orderBy: { created_at: "asc" },
        select: { id: true, type: true, amount: true, balance_before: true, balance_after: true, description: true },
      });

      const [packsResolved, cards, relatedTxs] = await Promise.all([
        packsPromise,
        cardsPromise,
        relatedTxsPromise,
      ]);
      packs = packsResolved;

      const cardsMap = new Map(cards.map((c) => [c.id, c]));

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
