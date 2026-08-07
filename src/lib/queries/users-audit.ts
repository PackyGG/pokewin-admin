import { queryMainRows } from "@/lib/drizzle-query";
import { toNumber } from "@/lib/utils/decimal";
import { officialStreamAdjustmentSqlPredicate } from "@/lib/balance-adjustment-categories";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";

export const RELEVANT_AUDIT_EVENT_TYPES = [
  "login",
  "logout",
  "register",
  "username_changed",
  "settings_changed",
] as const;

type AuditRow = {
  id: string;
  event_type: string;
  ip: string | null;
  country: string | null;
  created_at: Date | string;
  metadata: unknown;
};

type DepositRow = {
  id: string;
  amount: string;
  crypto_asset: string | null;
  crypto_amount: string | null;
  created_at: Date | string;
};

type WithdrawalRow = {
  id: string;
  total_value_usd: string;
  status: string;
  method: string;
  requested_at: Date | string;
};

type AdjustmentRow = {
  id: string;
  amount: string;
  description: string | null;
  created_at: Date | string;
};

export async function getUserAuditLog(
  userId: string,
  page: number = 1,
  perPage: number = 20,
  filters?: { eventType?: string },
) {
  const safePage = Math.max(1, Math.trunc(page) || 1);
  const safePerPage = Math.min(200, Math.max(1, Math.trunc(perPage) || 20));
  const isBlacklisted = (await getExcludedUserIds()).includes(userId);
  const explicitFilter =
    filters?.eventType && filters.eventType !== "all"
      ? filters.eventType
      : null;
  const showFinancials =
    !explicitFilter ||
    ["deposit", "withdrawal", "admin_balance_adjustment"].includes(
      explicitFilter,
    );

  const eventParams = explicitFilter
    ? [userId, explicitFilter]
    : [userId, ...RELEVANT_AUDIT_EVENT_TYPES];
  const eventPredicate = explicitFilter
    ? "event_type::text = $2"
    : `event_type::text = ANY(ARRAY[${RELEVANT_AUDIT_EVENT_TYPES.map(
        (_, index) => `$${index + 2}`,
      ).join(",")}])`;

  const [auditRows, depositRows, cardWithdrawalRows, balanceAdjustRows] =
    await Promise.all([
      queryMainRows<AuditRow[]>(
        `SELECT id, event_type::text AS event_type, ip, country, created_at, metadata
           FROM audit_events
          WHERE user_id = $1 AND ${eventPredicate}
          ORDER BY created_at DESC
          LIMIT 200`,
        ...eventParams,
      ),
      showFinancials
        ? queryMainRows<DepositRow[]>(
            `SELECT id, amount::text AS amount, crypto_asset,
                    crypto_amount::text AS crypto_amount, created_at
               FROM ledger_transactions
              WHERE user_id = $1
                AND type = 'deposit'
                AND status = 'completed'
              ORDER BY created_at DESC
              LIMIT 200`,
            userId,
          )
        : Promise.resolve([]),
      showFinancials && !isBlacklisted
        ? queryMainRows<WithdrawalRow[]>(
            `SELECT id, total_value_usd::text AS total_value_usd,
                    status::text AS status, method::text AS method, requested_at
               FROM card_withdrawal_requests
              WHERE user_id = $1
              ORDER BY requested_at DESC
              LIMIT 200`,
            userId,
          )
        : Promise.resolve([]),
      showFinancials
        ? queryMainRows<AdjustmentRow[]>(
            `SELECT id, amount::text AS amount, description, created_at
               FROM ledger_transactions lt
              WHERE user_id = $1
                AND type = 'admin_balance_adjustment'
                AND status = 'completed'
                AND NOT (${officialStreamAdjustmentSqlPredicate({
                  typeColumn: "lt.type",
                  metadataColumn: "lt.metadata",
                })})
              ORDER BY created_at DESC
              LIMIT 200`,
            userId,
          )
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
    ...auditRows.map((event) => ({
      id: event.id,
      eventType: event.event_type,
      ip: event.ip,
      country: event.country,
      createdAt: new Date(event.created_at).toISOString(),
      metadata: event.metadata,
    })),
    ...depositRows.map((deposit) => ({
      id: `dep_${deposit.id}`,
      eventType: "deposit",
      ip: null,
      country: null,
      createdAt: new Date(deposit.created_at).toISOString(),
      metadata: {
        amountUsd: toNumber(deposit.amount),
        cryptoAsset: deposit.crypto_asset,
        cryptoAmount:
          deposit.crypto_amount === null ? null : toNumber(deposit.crypto_amount),
      },
    })),
    ...cardWithdrawalRows.map((withdrawal) => ({
      id: `wd_${withdrawal.id}`,
      eventType: "withdrawal",
      ip: null,
      country: null,
      createdAt: new Date(withdrawal.requested_at).toISOString(),
      metadata: {
        amountUsd: toNumber(withdrawal.total_value_usd),
        method: withdrawal.method,
        status: withdrawal.status,
      },
    })),
    ...balanceAdjustRows
      .filter(
        (adjustment) =>
          !isBlacklisted || !/withdraw/i.test(adjustment.description ?? ""),
      )
      .map((adjustment) => ({
        id: `adj_${adjustment.id}`,
        eventType: "admin_balance_adjustment",
        ip: null,
        country: null,
        createdAt: new Date(adjustment.created_at).toISOString(),
        metadata: {
          amountUsd: toNumber(adjustment.amount),
          description: adjustment.description,
        },
      })),
  ];

  merged.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const total = merged.length;
  const start = (safePage - 1) * safePerPage;
  return {
    data: merged.slice(start, start + safePerPage),
    total,
    page: safePage,
    perPage: safePerPage,
    totalPages: Math.ceil(total / safePerPage),
  };
}
