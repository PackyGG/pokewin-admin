import { getDb } from "@/lib/db";
import { adminDb } from "@/lib/admin-db";
import { toNumber } from "@/lib/utils/decimal";
import type { PaginatedResult } from "@/lib/types";

export type VoucherListItem = {
  id: string;
  userId: string;
  username: string | null;
  value: number;
  origin: string;
  originLabel: string;
  description: string | null;
  createdByAdminId: string | null;
  createdByUsername: string | null;
  claimedAt: string | null;
  createdAt: string;
  isFtd?: boolean;
};

const ORIGIN_LABELS: Record<string, string> = {
  exchange_excess_to_voucher: "Exchange Excess",
  battle_excess_to_voucher: "Battle Excess",
  pack_borrow_to_voucher: "Pack Borrow",
  manual: "Manual",
};

export async function getVouchers(params: {
  page?: number;
  perPage?: number;
  claimed?: boolean;
  search?: string;
  minValue?: number;
  maxValue?: number;
  createdBy?: string; // admin user id
}): Promise<PaginatedResult<VoucherListItem>> {
  const db = await getDb();
  const { page = 1, perPage = 20, claimed, search, minValue, maxValue, createdBy } = params;

  // If filtering by createdBy, pre-fetch voucher IDs from admin DB
  let createdByVoucherIds: string[] | undefined;
  if (createdBy) {
    if (createdBy === "system") {
      // System = vouchers with NO admin action
      // We'll handle this post-query
    } else {
      const actions = await adminDb.admin_voucher_actions.findMany({
        where: { admin_user_id: createdBy, action: "created" },
        select: { voucher_id: true },
      });
      createdByVoucherIds = actions.map((a) => a.voucher_id);
      if (createdByVoucherIds.length === 0) {
        return { data: [], total: 0, page, perPage, totalPages: 0 };
      }
    }
  }

  const where: Record<string, unknown> = {};
  if (claimed === true) where.claimed_at = { not: null };
  else if (claimed === false) where.claimed_at = null;

  if (search) {
    where.user = {
      OR: [
        { username: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
        { id: search },
      ],
    };
  }

  if (minValue !== undefined || maxValue !== undefined) {
    const valueFilter: Record<string, number> = {};
    if (minValue !== undefined) valueFilter.gte = minValue;
    if (maxValue !== undefined) valueFilter.lte = maxValue;
    where.value = valueFilter;
  }

  if (createdByVoucherIds) {
    where.id = { in: createdByVoucherIds };
  }

  const [vouchers, total] = await Promise.all([
    db.vouchers.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
      include: {
        user: { select: { username: true } },
      },
    }),
    db.vouchers.count({ where }),
  ]);

  // Batch-fetch admin actions for creator info
  const voucherIds = vouchers.map((v) => v.id);
  const adminActions = voucherIds.length > 0
    ? await adminDb.admin_voucher_actions.findMany({
        where: { voucher_id: { in: voucherIds }, action: "created" },
        include: { admin_user: { select: { id: true, username: true } } },
      })
    : [];

  const creatorByVoucherId = new Map(
    adminActions.map((a) => [a.voucher_id, { id: a.admin_user.id, username: a.admin_user.username }])
  );

  // For "system" filter: exclude vouchers that have an admin creator
  let filteredVouchers = vouchers;
  if (createdBy === "system") {
    filteredVouchers = vouchers.filter((v) => !creatorByVoucherId.has(v.id));
  }

  // FTD lookup for claimed vouchers
  let ftdMap: Map<string, boolean> | undefined;
  if (claimed) {
    const userIds = [...new Set(filteredVouchers.map((v) => v.user_id))];
    if (userIds.length > 0) {
      const balances = await db.balances.findMany({
        where: { user_id: { in: userIds } },
        select: { user_id: true, total_deposited: true },
      });
      ftdMap = new Map(
        balances.map((b) => [b.user_id, toNumber(b.total_deposited) > 0])
      );
    }
  }

  const finalTotal = createdBy === "system" ? filteredVouchers.length : total;

  return {
    data: filteredVouchers.map((v) => ({
      id: v.id,
      userId: v.user_id,
      username: v.user?.username ?? null,
      value: toNumber(v.value),
      origin: v.origin,
      originLabel: ORIGIN_LABELS[v.origin] ?? v.origin,
      description: v.description,
      createdByAdminId: creatorByVoucherId.get(v.id)?.id ?? null,
      createdByUsername: creatorByVoucherId.get(v.id)?.username ?? null,
      claimedAt: v.claimed_at?.toISOString() ?? null,
      createdAt: v.created_at.toISOString(),
      ...(ftdMap ? { isFtd: ftdMap.get(v.user_id) ?? false } : {}),
    })),
    total: finalTotal,
    page,
    perPage,
    totalPages: Math.ceil(finalTotal / perPage),
  };
}

export async function getVoucherCreators() {
  const admins = await adminDb.admin_users.findMany({
    where: {
      voucher_actions: { some: { action: "created" } },
    },
    select: { id: true, username: true },
  });
  return admins;
}
