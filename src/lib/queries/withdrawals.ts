import { unstable_cache } from "next/cache";
import { getDb, getDevDb, getProdDb } from "@/lib/db";
import { readDbEnv, type DbEnv } from "@/lib/db-env";
import { toNumber } from "@/lib/utils/decimal";
import type { PaginatedResult } from "@/lib/types";
import { Prisma } from "@/generated/prisma/client";
import {
  card_withdrawal_status,
  card_withdrawal_method,
} from "@/generated/prisma/enums";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";

// Allowlists from the generated Prisma enums — validate user-supplied
// filter values before they hit the query rather than blind-casting.
const CWR_STATUSES = new Set<string>(Object.values(card_withdrawal_status));
const CWR_METHODS = new Set<string>(Object.values(card_withdrawal_method));

/**
 * Cache tag for the Withdrawals tab list. The admin actions in
 * `withdrawals/actions.ts` (process / ship / complete / cancel / fail)
 * call `revalidateTag(WITHDRAWALS_LIST_TAG)` after every mutation so a
 * just-actioned withdrawal never shows a stale status — `revalidatePath`
 * alone does NOT evict `unstable_cache` entries. Exported so the actions
 * import the exact same string (no drift between writer and reader).
 */
export const WITHDRAWALS_LIST_TAG = "transactions-withdrawals-list";

export type WithdrawalListItem = {
  id: string;
  userId: string;
  username: string | null;
  image: string | null;
  method: string;
  status: string;
  totalValueUsd: number;
  itemCount: number;
  requestedAt: string;
  processedBy: string | null;
  shippedBy: string | null;
  trackingNumber: string | null;
  carrier: string | null;
  failureReason: string | null;
  shippingAddressSnapshot: unknown;
  /**
   * Crypto asset code (e.g. "BTC", "ETH_TEST5") for crypto withdrawals,
   * null for physical ones. Surfaced on the list view so admins can see
   * which chain a withdrawal targets without opening the detail page.
   */
  cryptoAsset: string | null;
};

type GetWithdrawalsParams = {
  page?: number;
  perPage?: number;
  status?: string;
  statuses?: string[];
  method?: string;
  search?: string;
  minValue?: number;
  maxValue?: number;
};

/**
 * Actual Withdrawals-tab list query — the cached `getWithdrawals` below
 * is the public entry point.
 *
 * ── Why this is now cached (root-caused 2026-06-14) ────────────────────
 * The Withdrawals tab on `/transactions/deposits?tab=withdrawals` was
 * intermittently degrading to the amber "query timed out or failed"
 * band. EXPLAIN ANALYZE against live prod proved the query itself is
 * NOT slow: `card_withdrawal_requests` holds ~4.5k rows and every filter
 * variant (default, status, method, value-range, username-join search)
 * returns in 12–91ms. The real cause is CONNECTION-POOL contention: prod
 * `max_connections` is 100 and was observed at 111 open connections
 * ("sorry, too many clients already"). The Main-DB Prisma pool is
 * `max: 5` per env with a 10s connection-acquire timeout; when the pool
 * is saturated an uncached read queues until it times out → `safeQuery`'s
 * 15s budget fires → the band paints. The Deposits tab never showed this
 * because it is `unstable_cache`-wrapped (a cache hit touches no
 * connection at all); the Withdrawals tab was the only uncached read on
 * the page AND it re-fired on every render + every 60s `AutoRefresh`,
 * so it sat directly in the contention path.
 *
 * Fix: cache the list (60s, keyed on env + every filter + page) exactly
 * like {@link getDepositTransactions}, so the hot path (no filter /
 * repeated filter) is a cache hit and stops adding pool pressure. The
 * previous "deliberately uncached" note was correct that
 * `revalidatePath` can't evict `unstable_cache` — so the admin actions
 * in `withdrawals/actions.ts` now ALSO call
 * `revalidateTag(WITHDRAWALS_LIST_TAG)`, which keeps a just-actioned
 * withdrawal from showing a stale status. The page's existing
 * `safeQuery` degrade is unchanged (a true DB outage still paints the
 * band rather than crashing the route).
 *
 * `env` is threaded in (resolved in the request scope by the public
 * entry point) so the cache callback never calls `getDb()` — which reads
 * the request cookie via `cookies()`, illegal inside `unstable_cache` —
 * and so a dev-DB-toggled admin's cache entries never collide with prod.
 * Mirrors `computeDepositTransactions`.
 */
async function computeWithdrawals(
  env: DbEnv,
  blacklistKey: string,
  params: GetWithdrawalsParams,
): Promise<PaginatedResult<WithdrawalListItem>> {
  const { page = 1, perPage = 20, status, statuses, method, search, minValue, maxValue } = params;
  const safePerPage = Math.max(1, Math.min(200, Math.floor(perPage)));
  const safePage = Math.max(1, Math.floor(page));
  const db = env === "dev" ? getDevDb() : getProdDb();

  const where: Prisma.card_withdrawal_requestsWhereInput = {};

  // Admin-managed excluded-users blacklist: drop blacklisted users'
  // withdrawals from BOTH the list and the count so a blacklisted user
  // never surfaces on the Withdrawals tab (or /physical). `user_id` is a
  // plain column on card_withdrawal_requests, so a `notIn` predicate is a
  // simple index-friendly filter. Resolved OUTSIDE the cache and passed in
  // as `blacklistKey` so it participates in the cache key (mirrors
  // computeDepositTransactions). Empty key → no predicate added.
  const blacklistIds = blacklistKey ? blacklistKey.split(",") : [];
  if (blacklistIds.length > 0) {
    where.user_id = { notIn: blacklistIds };
  }

  if (statuses && statuses.length > 0) {
    const validStatuses = statuses.filter(
      (s): s is card_withdrawal_status => CWR_STATUSES.has(s),
    );
    if (validStatuses.length > 0) where.status = { in: validStatuses };
  } else if (status && status !== "all" && CWR_STATUSES.has(status)) {
    where.status = status as card_withdrawal_status;
  }

  if (method && CWR_METHODS.has(method)) {
    where.method = method as card_withdrawal_method;
  }

  if (minValue !== undefined || maxValue !== undefined) {
    where.total_value_usd = {};
    if (minValue !== undefined) where.total_value_usd.gte = minValue;
    if (maxValue !== undefined) where.total_value_usd.lte = maxValue;
  }

  if (search) {
    // `id` is a UUID column — comparing it against a non-UUID string
    // (e.g. a username fragment like "a") makes Postgres throw
    // `22P02 invalid input syntax for type uuid`, which crashed the whole
    // query and painted the page's amber "timed out or failed" band on
    // EVERY username search. Only include the id-equality leg when the
    // search term is actually UUID-shaped; otherwise search username +
    // email only. Mirrors the `isUuid` guard in getDepositTransactions.
    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        search,
      );
    where.OR = [
      ...(isUuid ? [{ id: search }] : []),
      { user_card_withdrawal_requests_user_idTouser: { username: { contains: search, mode: "insensitive" } } },
      { user_card_withdrawal_requests_user_idTouser: { email: { contains: search, mode: "insensitive" } } },
    ];
  }

  const [withdrawals, total] = await Promise.all([
    db.card_withdrawal_requests.findMany({
      where,
      orderBy: { requested_at: "desc" },
      skip: (safePage - 1) * safePerPage,
      take: safePerPage,
      include: {
        user_card_withdrawal_requests_user_idTouser: {
          select: { username: true, email: true, image: true },
        },
        user_card_withdrawal_requests_processed_byTouser: {
          select: { username: true },
        },
        user_card_withdrawal_requests_shipped_byTouser: {
          select: { username: true },
        },
      },
    }),
    db.card_withdrawal_requests.count({ where }),
  ]);

  return {
    data: withdrawals.map((w) => ({
      id: w.id,
      userId: w.user_id,
      username:
        w.user_card_withdrawal_requests_user_idTouser.username ??
        w.user_card_withdrawal_requests_user_idTouser.email,
      image: w.user_card_withdrawal_requests_user_idTouser.image,
      method: w.method,
      status: w.status,
      totalValueUsd: toNumber(w.total_value_usd),
      itemCount: w.inventory_item_ids.length + w.voucher_ids.length,
      // Serialized to an ISO string here so the cached payload survives
      // `unstable_cache`'s JSON round-trip cleanly (no Date→string drift
      // gotcha — the column never leaves this function as a Date).
      requestedAt: w.requested_at.toISOString(),
      processedBy:
        (w.metadata as Record<string, unknown>)?.processed_by_admin as string ??
        w.user_card_withdrawal_requests_processed_byTouser?.username ??
        null,
      shippedBy:
        (w.metadata as Record<string, unknown>)?.shipped_by_admin as string ??
        w.user_card_withdrawal_requests_shipped_byTouser?.username ??
        null,
      trackingNumber: w.tracking_number,
      carrier: w.carrier,
      failureReason: w.failure_reason,
      shippingAddressSnapshot: w.shipping_address_snapshot,
      cryptoAsset: w.crypto_asset,
    })),
    total,
    page: safePage,
    perPage: safePerPage,
    totalPages: Math.ceil(total / safePerPage),
  };
}

/**
 * Cross-request cache layer for the Withdrawals tab list.
 *
 * Wraps {@link computeWithdrawals} in a 60s `unstable_cache` keyed on
 * `(env, params)` — every distinct filter/page combination gets its own
 * entry, so re-opening the tab or paging back is an instant cache hit
 * that touches NO database connection (the whole point — see the root
 * cause in `computeWithdrawals`). Tagged so the admin actions can evict
 * it on mutation. Mirrors `cachedDepositTransactions`.
 */
const cachedWithdrawals = unstable_cache(
  computeWithdrawals,
  ["transactions-withdrawals-list-v2"],
  { revalidate: 60, tags: [WITHDRAWALS_LIST_TAG] },
);

/**
 * Public entry point for the Withdrawals tab. Resolves the request's DB
 * env (the cookie read happens HERE, in the request scope) then delegates
 * to the cached compute fn. See {@link computeWithdrawals} for the query
 * itself + the timeout root cause this caching fixes.
 */
export async function getWithdrawals(
  params: GetWithdrawalsParams,
): Promise<PaginatedResult<WithdrawalListItem>> {
  const env = await readDbEnv();
  // Resolve the excluded-users blacklist HERE, in the request scope
  // (getExcludedUserIds reads the admin DB; illegal inside
  // `unstable_cache`), then thread a stable sorted key through so it
  // participates in the cache key. Mirrors getDepositTransactions.
  const excluded = await getExcludedUserIds();
  const blacklistKey = [...excluded].sort().join(",");
  return cachedWithdrawals(env, blacklistKey, params);
}

export async function getWithdrawalDetail(id: string) {
  const db = await getDb();
  const withdrawal = await db.card_withdrawal_requests.findUnique({
    where: { id },
    include: {
      user_card_withdrawal_requests_user_idTouser: {
        select: {
          id: true,
          username: true,
          email: true,
        },
      },
      user_card_withdrawal_requests_processed_byTouser: {
        select: { username: true },
      },
      user_card_withdrawal_requests_shipped_byTouser: {
        select: { username: true },
      },
    },
  });

  if (!withdrawal) return null;

  const user = withdrawal.user_card_withdrawal_requests_user_idTouser;

  // Fetch inventory items and vouchers in parallel — they're independent.
  // Inventory items only carry card_id references; we need to fetch the
  // actual cards in a second round-trip. Only `id`, `image_url`, `name`,
  // `rarity` are needed downstream so the select stays tight.
  const [inventoryItems, voucherRows] = await Promise.all([
    withdrawal.inventory_item_ids.length > 0
      ? db.user_inventory.findMany({
          where: { id: { in: withdrawal.inventory_item_ids } },
          select: { id: true, card_id: true, value_at_obtained: true },
        })
      : Promise.resolve(
          [] as Array<{ id: string; card_id: string; value_at_obtained: unknown }>,
        ),
    withdrawal.voucher_ids.length > 0
      ? db.vouchers.findMany({
          where: { id: { in: withdrawal.voucher_ids } },
          select: { id: true, value: true, origin: true, description: true },
        })
      : Promise.resolve(
          [] as Array<{
            id: string;
            value: unknown;
            origin: string;
            description: string | null;
          }>,
        ),
  ]);

  let items: { id: string; cardName: string; imageUrl: string | null; rarity: string | null; value: number }[] = [];
  if (inventoryItems.length > 0) {
    const cardIds = [...new Set(inventoryItems.map((i) => i.card_id))];
    const cards = cardIds.length > 0
      ? await db.cards.findMany({
          where: { id: { in: cardIds } },
          select: { id: true, name: true, image_url: true, rarity: true },
        })
      : [];
    const cardMap = new Map(cards.map((c) => [c.id, c]));

    items = inventoryItems.map((item) => {
      const card = cardMap.get(item.card_id);
      return {
        id: item.id,
        cardName: card?.name ?? "Unknown Card",
        imageUrl: card?.image_url ?? null,
        rarity: card?.rarity ?? null,
        value: toNumber(item.value_at_obtained),
      };
    });
  }

  const vouchers: { id: string; value: number; origin: string; description: string | null }[] = voucherRows.map((v) => ({
    id: v.id,
    value: toNumber(v.value),
    origin: v.origin,
    description: v.description,
  }));

  return {
    id: withdrawal.id,
    userId: withdrawal.user_id,
    username: user.username ?? user.email,
    userEmail: user.email,
    method: withdrawal.method,
    status: withdrawal.status,
    totalValueUsd: toNumber(withdrawal.total_value_usd),
    shippingFeeUsd: toNumber(withdrawal.shipping_fee_usd),
    shippingAddressSnapshot: withdrawal.shipping_address_snapshot,
    trackingNumber: withdrawal.tracking_number,
    carrier: withdrawal.carrier,
    cryptoAsset: withdrawal.crypto_asset,
    cryptoAmount: toNumber(withdrawal.crypto_amount),
    destinationAddress: withdrawal.destination_address,
    txHash: withdrawal.tx_hash,
    failureReason: withdrawal.failure_reason,
    requestedAt: withdrawal.requested_at.toISOString(),
    processingAt: withdrawal.processing_at?.toISOString() ?? null,
    shippedAt: withdrawal.shipped_at?.toISOString() ?? null,
    completedAt: withdrawal.completed_at?.toISOString() ?? null,
    failedAt: withdrawal.failed_at?.toISOString() ?? null,
    cancelledAt: withdrawal.cancelled_at?.toISOString() ?? null,
    processedBy: (withdrawal.metadata as Record<string, unknown>)?.processed_by_admin as string ?? withdrawal.user_card_withdrawal_requests_processed_byTouser?.username ?? null,
    shippedBy: (withdrawal.metadata as Record<string, unknown>)?.shipped_by_admin as string ?? withdrawal.user_card_withdrawal_requests_shipped_byTouser?.username ?? null,
    items,
    vouchers,
    requiresConfirmation: withdrawal.requires_confirmation,
    confirmationReason: withdrawal.confirmation_reason,
    confirmedAt: withdrawal.confirmed_at?.toISOString() ?? null,
  };
}
