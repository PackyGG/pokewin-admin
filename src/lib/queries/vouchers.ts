import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { adminDb } from "@/lib/admin-db";
import { toNumber } from "@/lib/utils/decimal";
import { withTimeout } from "@/lib/errors/safe-query";
import type { PaginatedResult } from "@/lib/types";

/**
 * Wall-clock budget for the paginated voucher list. This is a live,
 * mutation-sensitive list (claims land continuously) so it is deliberately
 * NOT cross-request cached — but it can still fan across two DBs plus an
 * enrichment pass, so it gets a timeout so a slow/hung round-trip degrades
 * to a fallback at the call site instead of blocking the streamed section.
 */
const VOUCHERS_QUERY_TIMEOUT_MS = 12_000;

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
  creator_fill_conversion: "Creator Fill Conversion",
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
  // Bound the multi-DB fan-out so a slow round-trip degrades at the call
  // site (safeQuery in page.tsx) instead of hanging the streamed section.
  return withTimeout(() => getVouchersImpl(params), VOUCHERS_QUERY_TIMEOUT_MS);
}

async function getVouchersImpl(params: {
  page?: number;
  perPage?: number;
  claimed?: boolean;
  search?: string;
  minValue?: number;
  maxValue?: number;
  createdBy?: string;
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

// "Created By" filter options for the toolbar: the set of admins who have
// ever created a voucher. Tab-/filter-/page-independent, so it renders the
// same regardless of which voucher view is active and is safe to cache
// cross-request (60s) — mirrors the getVouchersListStats cache below.
const cachedVoucherCreators = unstable_cache(
  async () => {
    const admins = await adminDb.admin_users.findMany({
      where: {
        voucher_actions: { some: { action: "created" } },
      },
      select: { id: true, username: true },
    });
    return admins;
  },
  ["voucher-creators-v1"],
  { revalidate: 60, tags: ["voucher-creators"] },
);

export async function getVoucherCreators() {
  return cachedVoucherCreators();
}

// ─── Global KPI stats for the /vouchers page hero strip ───────────────
//
// Whole-table counts + value totals split by claimed status. Both halves
// of the split are always returned so the tab switch (Unclaimed /
// Claimed) doesn't trigger a re-fetch — the stats card is a fixed
// 4-tile read-out regardless of which tab is active.
//
// One COUNT(*) FILTER + SUM round-trip; cached cross-request (60s).

export type VouchersListStats = {
  unclaimedCount: number;
  unclaimedTotalValue: number;
  claimedCount: number;
  claimedTotalValue: number;
};

const cachedVouchersListStats = unstable_cache(
  async (): Promise<VouchersListStats> => {
    const db = await getDb();
    const rows = await db.$queryRaw<
      {
        unclaimed_count: string;
        unclaimed_total: string;
        claimed_count: string;
        claimed_total: string;
      }[]
    >`
      SELECT
        COUNT(*) FILTER (WHERE claimed_at IS NULL)::text                                           AS unclaimed_count,
        COALESCE(SUM(value::numeric) FILTER (WHERE claimed_at IS NULL), 0)::text                   AS unclaimed_total,
        COUNT(*) FILTER (WHERE claimed_at IS NOT NULL)::text                                       AS claimed_count,
        COALESCE(SUM(value::numeric) FILTER (WHERE claimed_at IS NOT NULL), 0)::text               AS claimed_total
      FROM vouchers
    `;
    const r = rows[0];
    return {
      unclaimedCount: Number(r?.unclaimed_count ?? 0),
      unclaimedTotalValue: Number(r?.unclaimed_total ?? 0),
      claimedCount: Number(r?.claimed_count ?? 0),
      claimedTotalValue: Number(r?.claimed_total ?? 0),
    };
  },
  ["vouchers-list-stats-v1"],
  { revalidate: 60, tags: ["vouchers-list-stats"] },
);

export async function getVouchersListStats(): Promise<VouchersListStats> {
  return cachedVouchersListStats();
}
