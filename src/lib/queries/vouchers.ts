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

/**
 * List vouchers with paginated server-side ordering.
 *
 * Authoritative ordering source: Main DB (`vouchers.created_at DESC`). All
 * sortable/filterable columns (created_at, claimed_at, value, user search)
 * live in Main DB, so ORDER BY + LIMIT/OFFSET + COUNT happen entirely at
 * SQL level on Main DB — no in-memory pagination, no spilling.
 *
 * Admin DB (`admin_voucher_actions`) is used only as an enrichment lookup
 * (creator metadata) AND as a way to translate the "Created By" filter
 * into a set of voucher IDs (or NOT-IN set for the "system" pseudo-value)
 * that we then push back into the Main-DB WHERE clause. We never join
 * across DBs at SQL level — strict dual-DB separation per CLAUDE.md.
 */
export async function getVouchers(params: {
  page?: number;
  perPage?: number;
  claimed?: boolean;
  search?: string;
  minValue?: number;
  maxValue?: number;
  createdBy?: string; // admin user id, or "system" for vouchers without an admin action
}): Promise<PaginatedResult<VoucherListItem>> {
  const db = await getDb();
  const { page = 1, perPage = 20, claimed, search, minValue, maxValue, createdBy } = params;

  // Translate the "Created By" filter into a Main-DB id constraint by
  // pre-fetching the relevant voucher_ids from Admin DB. Only IDs are
  // pulled across — no rows joined cross-DB.
  //
  // - createdBy = <admin uuid>: WHERE id IN (their created voucher ids)
  // - createdBy = "system":     WHERE id NOT IN (any admin-created voucher ids)
  // - createdBy = undefined:    no constraint added.
  const where: Record<string, unknown> = {};

  if (createdBy === "system") {
    const allAdminCreated = await adminDb.admin_voucher_actions.findMany({
      where: { action: "created" },
      select: { voucher_id: true },
    });
    const adminCreatedIds = allAdminCreated.map((a) => a.voucher_id);
    // If there are no admin-created vouchers at all, "system" matches
    // everything — leave the where clause untouched.
    if (adminCreatedIds.length > 0) {
      where.id = { notIn: adminCreatedIds };
    }
  } else if (createdBy) {
    const actions = await adminDb.admin_voucher_actions.findMany({
      where: { admin_user_id: createdBy, action: "created" },
      select: { voucher_id: true },
    });
    const createdByVoucherIds = actions.map((a) => a.voucher_id);
    if (createdByVoucherIds.length === 0) {
      return { data: [], total: 0, page, perPage, totalPages: 0 };
    }
    where.id = { in: createdByVoucherIds };
  }

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

  // SQL-level ORDER BY + LIMIT/OFFSET + COUNT on the authoritative source.
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

  // Enrichment pass: fetch admin-actor metadata + (when filtering claimed)
  // FTD balance flags in parallel — they target different DBs and have no
  // dependency on each other.
  const voucherIds = vouchers.map((v) => v.id);
  const ftdUserIds = claimed
    ? [...new Set(vouchers.map((v) => v.user_id))]
    : [];

  const adminActionsPromise = voucherIds.length > 0
    ? adminDb.admin_voucher_actions.findMany({
        where: { voucher_id: { in: voucherIds }, action: "created" },
        include: { admin_user: { select: { id: true, username: true } } },
      })
    : Promise.resolve([]);
  const balanceRowsPromise = ftdUserIds.length > 0
    ? db.balances.findMany({
        where: { user_id: { in: ftdUserIds } },
        select: { user_id: true, total_deposited: true },
      })
    : Promise.resolve(
        [] as Array<{ user_id: string; total_deposited: unknown }>,
      );

  const [adminActions, balanceRows] = await Promise.all([
    adminActionsPromise,
    balanceRowsPromise,
  ]);

  const creatorByVoucherId = new Map(
    adminActions.map((a) => [a.voucher_id, { id: a.admin_user.id, username: a.admin_user.username }])
  );

  const ftdMap = claimed
    ? new Map(balanceRows.map((b) => [b.user_id, toNumber(b.total_deposited) > 0]))
    : undefined;

  return {
    data: vouchers.map((v) => ({
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
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
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
