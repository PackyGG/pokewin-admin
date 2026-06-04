import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { Prisma } from "@/generated/prisma/client";
import { officialStreamAdjustmentPrismaWhere } from "@/lib/balance-adjustment-categories";

// Only the audit_events.event_type values that the backend actually emits
// AND are relevant to the "important account activity" view. Verified
// against the prod audit_events table.
// Deposits/withdrawals are merged in separately from ledger_transactions /
// card_withdrawal_requests below.
export const RELEVANT_AUDIT_EVENT_TYPES = [
  "login",
  "logout",
  "register",
  "username_changed",
  "settings_changed",
] as const;

export async function getUserAuditLog(
  userId: string,
  page: number = 1,
  perPage: number = 20,
  filters?: { eventType?: string }
) {
  const db = await getDb();
  const explicitFilter =
    filters?.eventType && filters.eventType !== "all"
      ? filters.eventType
      : null;

  // 1) Audit events from audit_events table, restricted to the relevant set
  const auditWhere: Prisma.audit_eventsWhereInput = {
    user_id: userId,
    event_type: (explicitFilter
      ? (explicitFilter as Prisma.audit_eventsWhereInput["event_type"])
      : {
          in: [...RELEVANT_AUDIT_EVENT_TYPES],
        }) as Prisma.audit_eventsWhereInput["event_type"],
  };

  // 2) Synthetic events from ledger_transactions (deposits + crypto withdrawals)
  //    and card_withdrawal_requests (item withdrawals). These run in parallel
  //    so we get one merged, paginated, time-ordered stream.
  const showFinancials =
    !explicitFilter || ["deposit", "withdrawal", "admin_balance_adjustment"].includes(explicitFilter);

  const [auditRows, depositRows, cardWithdrawalRows, balanceAdjustRows] = await Promise.all([
    db.audit_events.findMany({
      where: auditWhere,
      orderBy: { created_at: "desc" },
      // Take a generous slice — we paginate after merging.
      take: 200,
    }),
    showFinancials
      ? db.ledger_transactions.findMany({
          where: {
            user_id: userId,
            type: "deposit",
            status: "completed",
          },
          orderBy: { created_at: "desc" },
          take: 200,
          select: {
            id: true,
            amount: true,
            crypto_asset: true,
            crypto_amount: true,
            created_at: true,
          },
        })
      : Promise.resolve([]),
    showFinancials
      ? db.card_withdrawal_requests.findMany({
          where: { user_id: userId },
          orderBy: { requested_at: "desc" },
          take: 200,
          select: {
            id: true,
            total_value_usd: true,
            status: true,
            method: true,
            requested_at: true,
          },
        })
      : Promise.resolve([]),
    showFinancials
      ? db.ledger_transactions.findMany({
          where: {
            user_id: userId,
            type: "admin_balance_adjustment",
            status: "completed",
            // FAKE-BALANCE: hide official_stream adjustments from this
            // per-user account-activity feed (owner-designated fake balance).
            NOT: officialStreamAdjustmentPrismaWhere(),
          },
          orderBy: { created_at: "desc" },
          take: 200,
          select: {
            id: true,
            amount: true,
            description: true,
            created_at: true,
          },
        })
      : Promise.resolve([]),
  ]);

  type Row = {
    id: string;
    eventType: string;
    ip: string | null;
    country: string | null;
    createdAt: string;
    metadata: unknown;
  };

  const merged: Row[] = [
    ...auditRows.map((e) => ({
      id: e.id,
      eventType: e.event_type,
      ip: e.ip,
      country: e.country,
      createdAt: e.created_at.toISOString(),
      metadata: e.metadata,
    })),
    ...depositRows.map((d) => ({
      id: `dep_${d.id}`,
      eventType: "deposit",
      ip: null,
      country: null,
      createdAt: d.created_at.toISOString(),
      metadata: {
        amountUsd: toNumber(d.amount),
        cryptoAsset: d.crypto_asset,
        cryptoAmount: d.crypto_amount ? toNumber(d.crypto_amount) : null,
      },
    })),
    ...cardWithdrawalRows.map((w) => ({
      id: `wd_${w.id}`,
      eventType: "withdrawal",
      ip: null,
      country: null,
      createdAt: w.requested_at.toISOString(),
      metadata: {
        amountUsd: toNumber(w.total_value_usd),
        method: w.method,
        status: w.status,
      },
    })),
    ...balanceAdjustRows.map((a) => ({
      id: `adj_${a.id}`,
      eventType: "admin_balance_adjustment",
      ip: null,
      country: null,
      createdAt: a.created_at.toISOString(),
      metadata: {
        amountUsd: toNumber(a.amount),
        description: a.description,
      },
    })),
  ];

  merged.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const total = merged.length;
  const start = (page - 1) * perPage;
  const data = merged.slice(start, start + perPage);

  return {
    data,
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}
