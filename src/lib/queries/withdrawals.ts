import { unstable_cache } from "next/cache";
import { drizzleForEnv } from "@/lib/db";
import { queryMainRows, queryRows } from "@/lib/drizzle-query";
import { readDbEnv, type DbEnv } from "@/lib/db-env";
import { toNumber } from "@/lib/utils/decimal";
import type { PaginatedResult } from "@/lib/types";
import {
  card_withdrawal_status,
  card_withdrawal_method,
} from "@/lib/db-schema/main/schema";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getWithdrawalUnlockedUserIds } from "@/lib/withdrawal-lock/lock";

// Allowlists from the generated Drizzle enums — validate user-supplied
// filter values before they hit the query rather than blind-casting.
const CWR_STATUSES = new Set<string>(card_withdrawal_status.enumValues);
const CWR_METHODS = new Set<string>(card_withdrawal_method.enumValues);

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
 * ("sorry, too many clients already"). The Main-DB runtime pool is
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
 * entry point) so the cache callback never resolves request state — which reads
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
  const db = drizzleForEnv(env);
  const binds: unknown[] = [];
  const filters: string[] = [];

  // Withdrawal-LOCKED users: drop their withdrawals from BOTH the list and
  // the count so a locked user never surfaces on the Withdrawals tab (or
  // /physical). The locked set = excluded_users blacklist MINUS the users
  // motha has granted a per-user withdrawal unlock (admin_withdrawal_unlocks);
  // an unlocked excluded user's withdrawals become visible + actionable again.
  // `user_id` is a plain column on card_withdrawal_requests, so a `notIn`
  // predicate is a simple index-friendly filter. Resolved OUTSIDE the cache
  // and passed in as `blacklistKey` so it participates in the cache key
  // (mirrors computeDepositTransactions). Empty key → no predicate added.
  const blacklistIds = blacklistKey ? blacklistKey.split(",") : [];
  binds.push(blacklistIds);
  filters.push(`NOT (cwr.user_id = ANY($1::text[]))`);

  if (statuses && statuses.length > 0) {
    const validStatuses = statuses.filter((s) => CWR_STATUSES.has(s));
    if (validStatuses.length > 0) {
      binds.push(validStatuses);
      filters.push(`cwr.status::text = ANY($${binds.length}::text[])`);
    }
  } else if (status && status !== "all" && CWR_STATUSES.has(status)) {
    binds.push(status);
    filters.push(`cwr.status::text = $${binds.length}`);
  }

  if (method && CWR_METHODS.has(method)) {
    binds.push(method);
    filters.push(`cwr.method::text = $${binds.length}`);
  }

  if (minValue !== undefined && Number.isFinite(minValue)) {
    binds.push(minValue);
    filters.push(`cwr.total_value_usd::numeric >= $${binds.length}`);
  }
  if (maxValue !== undefined && Number.isFinite(maxValue)) {
    binds.push(maxValue);
    filters.push(`cwr.total_value_usd::numeric <= $${binds.length}`);
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
    binds.push(`%${search.toLowerCase()}%`);
    const fuzzy = `$${binds.length}`;
    if (isUuid) {
      binds.push(search);
      filters.push(
        `(LOWER(requester.username) LIKE ${fuzzy}
          OR LOWER(requester.email) LIKE ${fuzzy}
          OR cwr.id = $${binds.length}::uuid)`,
      );
    } else {
      filters.push(
        `(LOWER(requester.username) LIKE ${fuzzy}
          OR LOWER(requester.email) LIKE ${fuzzy})`,
      );
    }
  }
  const whereSql = filters.join(" AND ");
  const limitIndex = binds.length + 1;
  const offsetIndex = binds.length + 2;
  type WithdrawalRow = {
    id: string;
    user_id: string;
    requester_username: string | null;
    requester_email: string | null;
    requester_image: string | null;
    processed_username: string | null;
    shipped_username: string | null;
    method: string;
    status: string;
    total_value_usd: string;
    inventory_item_ids: string[];
    voucher_ids: string[];
    requested_at: Date;
    metadata: unknown;
    tracking_number: string | null;
    carrier: string | null;
    failure_reason: string | null;
    shipping_address_snapshot: unknown;
    crypto_asset: string | null;
  };
  const [withdrawals, countRows] = await Promise.all([
    queryRows<WithdrawalRow[]>(
      db,
      `SELECT cwr.id, cwr.user_id,
              requester.username AS requester_username,
              requester.email AS requester_email,
              requester.image AS requester_image,
              processor.username AS processed_username,
              shipper.username AS shipped_username,
              cwr.method::text AS method, cwr.status::text AS status,
              cwr.total_value_usd::text, cwr.inventory_item_ids,
              cwr.voucher_ids, cwr.requested_at, cwr.metadata,
              cwr.tracking_number, cwr.carrier, cwr.failure_reason,
              cwr.shipping_address_snapshot, cwr.crypto_asset
         FROM card_withdrawal_requests cwr
         JOIN "user" requester ON requester.id = cwr.user_id
         LEFT JOIN "user" processor ON processor.id = cwr.processed_by
         LEFT JOIN "user" shipper ON shipper.id = cwr.shipped_by
        WHERE ${whereSql}
        ORDER BY cwr.requested_at DESC
        LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
      ...binds,
      safePerPage,
      (safePage - 1) * safePerPage,
    ),
    queryRows<{ total: string }[]>(
      db,
      `SELECT COUNT(*)::text AS total
         FROM card_withdrawal_requests cwr
         JOIN "user" requester ON requester.id = cwr.user_id
        WHERE ${whereSql}`,
      ...binds,
    ),
  ]);
  const total = Number(countRows[0]?.total ?? 0);

  return {
    data: withdrawals.map((w) => ({
      id: w.id,
      userId: w.user_id,
      username:
        w.requester_username ?? w.requester_email,
      image: w.requester_image,
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
        w.processed_username ??
        null,
      shippedBy:
        (w.metadata as Record<string, unknown>)?.shipped_by_admin as string ??
        w.shipped_username ??
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
  // Resolve the withdrawal-LOCKED set HERE, in the request scope (both admin
  // DB reads are illegal inside `unstable_cache`): the excluded_users
  // blacklist minus the users motha has unlocked. Only genuinely locked users
  // are dropped from the list; a motha-unlocked excluded user reappears so
  // their withdrawals can be actioned. Thread a stable sorted key through so
  // it participates in the cache key. Mirrors getDepositTransactions.
  const [excluded, unlocked] = await Promise.all([
    getExcludedUserIds(),
    getWithdrawalUnlockedUserIds(),
  ]);
  const lockedIds = excluded.filter((id) => !unlocked.has(id));
  const blacklistKey = [...lockedIds].sort().join(",");
  return cachedWithdrawals(env, blacklistKey, params);
}

/**
 * Actual withdrawal-detail read: the request row (with the requester /
 * processor / shipper user joins) plus a parallel inventory-items +
 * vouchers fan-out and a follow-up cards lookup — a multi-round-trip read
 * on the money-exact critical path. The cached + safeQuery-wrapped public
 * entry point is {@link getWithdrawalDetail} below; this `compute*` does
 * the real work.
 */
async function computeWithdrawalDetail(id: string) {
  const rows = await queryMainRows<
    {
      id: string;
      user_id: string;
      username: string | null;
      email: string | null;
      processed_username: string | null;
      shipped_username: string | null;
      method: string;
      status: string;
      total_value_usd: string;
      shipping_fee_usd: string;
      shipping_address_snapshot: unknown;
      tracking_number: string | null;
      carrier: string | null;
      crypto_asset: string | null;
      crypto_amount: string | null;
      destination_address: string | null;
      tx_hash: string | null;
      failure_reason: string | null;
      requested_at: Date;
      processing_at: Date | null;
      shipped_at: Date | null;
      completed_at: Date | null;
      failed_at: Date | null;
      cancelled_at: Date | null;
      metadata: unknown;
      inventory_item_ids: string[];
      voucher_ids: string[];
    }[]
  >(
    `SELECT cwr.id, cwr.user_id, requester.username, requester.email,
            processor.username AS processed_username,
            shipper.username AS shipped_username,
            cwr.method::text AS method, cwr.status::text AS status,
            cwr.total_value_usd::text, cwr.shipping_fee_usd::text,
            cwr.shipping_address_snapshot, cwr.tracking_number, cwr.carrier,
            cwr.crypto_asset, cwr.crypto_amount::text,
            cwr.destination_address, cwr.tx_hash, cwr.failure_reason,
            cwr.requested_at, cwr.processing_at, cwr.shipped_at,
            cwr.completed_at, cwr.failed_at, cwr.cancelled_at,
            cwr.metadata, cwr.inventory_item_ids, cwr.voucher_ids
       FROM card_withdrawal_requests cwr
       JOIN "user" requester ON requester.id = cwr.user_id
       LEFT JOIN "user" processor ON processor.id = cwr.processed_by
       LEFT JOIN "user" shipper ON shipper.id = cwr.shipped_by
      WHERE cwr.id = $1::uuid LIMIT 1`,
    id,
  );
  const withdrawal = rows[0];

  if (!withdrawal) return null;

  // Fetch inventory items and vouchers in parallel — they're independent.
  // Inventory items only carry card_id references; we need to fetch the
  // actual cards in a second round-trip. Only `id`, `image_url`, `name`,
  // `rarity` are needed downstream so the select stays tight.
  const [inventoryItems, voucherRows] = await Promise.all([
    withdrawal.inventory_item_ids.length > 0
      ? queryMainRows<
          { id: string; card_id: string; value_at_obtained: string }[]
        >(
          `SELECT id, card_id, value_at_obtained::text
             FROM user_inventory WHERE id = ANY($1::uuid[])`,
          withdrawal.inventory_item_ids,
        )
      : Promise.resolve(
          [] as Array<{ id: string; card_id: string; value_at_obtained: unknown }>,
        ),
    withdrawal.voucher_ids.length > 0
      ? queryMainRows<
          { id: string; value: string; origin: string; description: string | null }[]
        >(
          `SELECT id, value::text, origin::text, description
             FROM vouchers WHERE id = ANY($1::uuid[])`,
          withdrawal.voucher_ids,
        )
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
      ? await queryMainRows<
          { id: string; name: string; image_url: string | null; rarity: string | null }[]
        >(
          `SELECT id, name, image_url, rarity::text
             FROM cards WHERE id = ANY($1::uuid[])`,
          cardIds,
        )
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
    username: withdrawal.username ?? withdrawal.email,
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
    processedBy: (withdrawal.metadata as Record<string, unknown>)?.processed_by_admin as string ?? withdrawal.processed_username ?? null,
    shippedBy: (withdrawal.metadata as Record<string, unknown>)?.shipped_by_admin as string ?? withdrawal.shipped_username ?? null,
    items,
    vouchers,
  };
}

/**
 * Cross-request cache for the withdrawal-detail read.
 *
 * `computeWithdrawalDetail` is a multi-round-trip money-exact read that the
 * detail page re-fires on every load + every segment "Try again", adding
 * pool pressure on the `max: 3` warm-instance pool. Caching collapses
 * repeat loads of the same withdrawal onto one warmed entry.
 *
 * Freshness after an admin action is safe WITHOUT any extra wiring: this
 * cache is tagged with the SAME {@link WITHDRAWALS_LIST_TAG} the list cache
 * uses, and every mutation in `withdrawals/actions.ts` (process / ship /
 * complete / cancel / fail) already calls `revalidateTag(WITHDRAWALS_LIST_TAG)`,
 * which evicts this entry too — so a just-actioned withdrawal never shows a
 * stale status here. The 60s TTL is the backstop between actions; withdrawals
 * are not mutated from anywhere but those actions. Same prod-only,
 * env-resolved-outside pattern as `cachedWithdrawals` above.
 *
 * `computeWithdrawalDetail` resolves its request-scoped client internally; inside the cache
 * callback the `admin_db_env` cookie read falls back to "prod", so the cached
 * callback always queries the PROD client. We therefore cache ONLY on prod
 * (see {@link getWithdrawalDetail}); a dev-toggled admin reads live.
 */
function cachedWithdrawalDetail(id: string) {
  return unstable_cache(
    () => computeWithdrawalDetail(id),
    ["withdrawal-detail-v1", id],
    { revalidate: 60, tags: [WITHDRAWALS_LIST_TAG] },
  )();
}

/**
 * Public entry point for the withdrawal-detail page. Resolves the request
 * DB env HERE (cookie read is illegal inside `unstable_cache`): a prod
 * request goes through the cache; a dev-toggled admin reads live so they
 * always see dev data. See {@link computeWithdrawalDetail} for the query.
 */
export async function getWithdrawalDetail(id: string) {
  const env = await readDbEnv();
  if (env !== "prod") return computeWithdrawalDetail(id);
  return cachedWithdrawalDetail(id);
}
