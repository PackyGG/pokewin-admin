import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import type { PaginatedResult } from "@/lib/types";
import { Prisma } from "@/generated/prisma/client";
import {
  card_withdrawal_status,
  card_withdrawal_method,
} from "@/generated/prisma/enums";

// Allowlists from the generated Prisma enums — validate user-supplied
// filter values before they hit the query rather than blind-casting.
const CWR_STATUSES = new Set<string>(Object.values(card_withdrawal_status));
const CWR_METHODS = new Set<string>(Object.values(card_withdrawal_method));

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

/**
 * Withdrawals tab list query.
 *
 * NOTE — deliberately NOT `unstable_cache`-wrapped (unlike the Deposits
 * tab's {@link getDepositTransactions}). `card_withdrawal_requests` is
 * mutated by the admin actions in `withdrawals/actions.ts`
 * (process / ship / complete / cancel / fail), which invalidate the view
 * via `revalidatePath("/withdrawals")`. `revalidatePath` does NOT evict
 * `unstable_cache` entries (those clear only on a matching
 * `revalidateTag` or their TTL), so caching this list would leave a
 * just-actioned withdrawal showing its stale status for up to the TTL —
 * a behaviour regression. The AutoRefresh on the page + the fresh read
 * on every navigation keep the withdrawals tab correct; switching back
 * re-runs this lean indexed query. (Cacheing it safely would mean adding
 * `revalidateTag("transactions-withdrawals-list")` to those actions,
 * which live outside this change's scope.)
 */
export async function getWithdrawals(params: {
  page?: number;
  perPage?: number;
  status?: string;
  statuses?: string[];
  method?: string;
  search?: string;
  minValue?: number;
  maxValue?: number;
}): Promise<PaginatedResult<WithdrawalListItem>> {
  const { page = 1, perPage = 20, status, statuses, method, search, minValue, maxValue } = params;
  const db = await getDb();

  const where: Prisma.card_withdrawal_requestsWhereInput = {};

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
    where.OR = [
      { id: search },
      { user_card_withdrawal_requests_user_idTouser: { username: { contains: search, mode: "insensitive" } } },
      { user_card_withdrawal_requests_user_idTouser: { email: { contains: search, mode: "insensitive" } } },
    ];
  }

  const [withdrawals, total] = await Promise.all([
    db.card_withdrawal_requests.findMany({
      where,
      orderBy: { requested_at: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
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
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
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
          shipping_addresses: true,
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
    shippingAddress: user.shipping_addresses,
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
