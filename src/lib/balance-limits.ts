import { sql } from "drizzle-orm";
import { adminDrizzle } from "@/lib/admin-db";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { getRoleBalanceLimitDefaults } from "@/lib/role-limits";
import {
  resolveEffectiveCap,
  type RoleBalanceLimitDefaults,
} from "@/lib/role-limits-merge";
export type limit_period_type = "daily" | "weekly" | "monthly";

function getPeriodStart(periodType: limit_period_type): Date {
  const now = new Date();
  switch (periodType) {
    case "daily":
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    case "weekly": {
      const day = now.getUTCDay();
      const diff = day === 0 ? 6 : day - 1; // Monday = start of week
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - diff));
    }
    case "monthly":
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }
}

/**
 * Sum the USD an admin has already moved within the current `period` window.
 *
 * Unchanged logic, extracted from `checkBalanceAdjustmentLimit` so the cap
 * merge (per-user row → else role default) can compute usage per period
 * without duplicating it. Both event types count against the same cap:
 * - `balance_adjustment` is the regular adjustBalance() audit event
 *   (metadata.amount carries the signed delta in USD).
 * - `manual_withdrawal_recorded` is recordManualWithdrawal()
 *   (metadata.amountUsd carries the positive USD amount that was moved off the
 *   user's on-site balance).
 * Manual withdrawals move user money around just like a balance adjustment
 * does, so we sum both event types. Returns the absolute total (always ≥ 0).
 */
async function sumPeriodUsage(
  adminUserId: string,
  period: limit_period_type,
): Promise<number> {
  const periodStart = getPeriodStart(period);

  const result = await adminDrizzle.execute<{ current_usage: string }>(sql`
    SELECT COALESCE(SUM(ABS(
      CASE
        WHEN jsonb_typeof(metadata->'amount') = 'number'
          THEN (metadata->>'amount')::numeric
        WHEN jsonb_typeof(metadata->'amountUsd') = 'number'
          THEN (metadata->>'amountUsd')::numeric
        ELSE 0
      END
    )), 0)::text AS current_usage
    FROM admin_audit_events
    WHERE admin_user_id = ${adminUserId}::uuid
      AND event_type IN ('balance_adjustment', 'manual_withdrawal_recorded')
      AND created_at >= ${periodStart}
  `);
  return Number(result.rows[0]?.current_usage ?? 0);
}

const ALL_PERIODS: readonly limit_period_type[] = ["daily", "weekly", "monthly"];

/**
 * Enforce the admin's balance-adjustment cap before a balance move.
 *
 * Effective cap per period = `userRow.max ?? roleDefault[period] ?? null`
 * (per-user-row WINS → else the role default → else unlimited). Today every
 * role's limit columns are NULL, so `roleDefault` is all-null and this is
 * IDENTICAL to the previous per-user-only behavior:
 *   • no per-user row AND no role cap for any period ⇒ early return (unlimited),
 *   • a per-user row ⇒ that row's cap is enforced exactly as before.
 * When a period has a cap, throws the SAME message shape if
 * `usage + |amount| > max`.
 */
export async function checkBalanceAdjustmentLimit(
  adminUserId: string,
  amount: number
): Promise<void> {
  // Per-user caps (the authoritative WINNER when present), keyed by period.
  const userLimits = (await adminDrizzle.execute<{
    period_type: limit_period_type;
    max_amount: string;
  }>(sql`
    SELECT period_type::text AS period_type, max_amount::text AS max_amount
    FROM admin_balance_limits
    WHERE admin_user_id = ${adminUserId}
  `)).rows;
  const userMaxByPeriod = new Map<limit_period_type, number>();
  for (const l of userLimits) {
    userMaxByPeriod.set(l.period_type, Number(l.max_amount));
  }

  // Role-level defaults (lower layer). Inert today (all columns NULL).
  let roleDefaults: RoleBalanceLimitDefaults;
  try {
    roleDefaults = await getRoleBalanceLimitDefaults(adminUserId);
  } catch {
    // A role-default read failure must NOT loosen OR tighten the per-user cap:
    // fall back to "no role default" so per-user rows still enforce exactly.
    roleDefaults = { daily: null, weekly: null, monthly: null };
  }

  // Resolve the effective cap per period: per-user row ?? role default ?? null.
  const effectiveByPeriod: Array<{ period: limit_period_type; max: number }> = [];
  for (const period of ALL_PERIODS) {
    const userMax = userMaxByPeriod.get(period);
    const effectiveMax = resolveEffectiveCap(userMax, roleDefaults[period]);
    if (effectiveMax !== null) {
      effectiveByPeriod.push({ period, max: effectiveMax });
    }
  }

  // No capped period at all ⇒ unlimited (identical to today's empty-rows path).
  if (effectiveByPeriod.length === 0) return;

  const requestedAmount = Math.abs(amount);

  for (const { period, max } of effectiveByPeriod) {
    const currentUsage = await sumPeriodUsage(adminUserId, period);
    if (currentUsage + requestedAmount > max) {
      throw new Error(
        `Balance adjustment limit exceeded for ${period} period. ` +
        `Used: $${currentUsage.toFixed(2)} / $${max.toFixed(2)}. ` +
        `Requested: $${requestedAmount.toFixed(2)}`
      );
    }
  }
}

export async function getLimitsForAdmin(adminUserId: string) {
  return (await adminDrizzle.execute<{
    id: string;
    admin_user_id: string;
    period_type: limit_period_type;
    max_amount: string;
    created_at: Date | string;
    updated_at: Date | string;
    created_by: string | null;
    updated_by: string | null;
  }>(sql`
    SELECT id::text, admin_user_id, period_type::text AS period_type,
           max_amount::text AS max_amount, created_at, updated_at,
           created_by, updated_by
    FROM admin_balance_limits
    WHERE admin_user_id = ${adminUserId}
  `)).rows;
}

export async function getAllLimits() {
  return (await adminDrizzle.execute<{
    id: string;
    admin_user_id: string;
    period_type: limit_period_type;
    max_amount: string;
    created_at: Date | string;
    updated_at: Date | string;
    created_by: string | null;
    updated_by: string | null;
    adminUsername: string;
    adminEmail: string;
  }>(sql`
    SELECT l.id::text, l.admin_user_id,
           l.period_type::text AS period_type, l.max_amount::text AS max_amount,
           l.created_at, l.updated_at, l.created_by, l.updated_by,
           COALESCE(u.username, 'Unknown') AS "adminUsername",
           COALESCE(u.email, 'Unknown') AS "adminEmail"
    FROM admin_balance_limits l
    LEFT JOIN admin_users u ON u.id::text = l.admin_user_id
    ORDER BY l.created_at DESC
  `)).rows;
}

export async function setLimit(params: {
  adminUserId: string;
  periodType: limit_period_type;
  maxAmount: number;
  setBy: string;
}) {
  const { adminUserId, periodType, maxAmount, setBy } = params;

  const result = await adminDrizzle.execute(sql`
    INSERT INTO admin_balance_limits (
      admin_user_id, period_type, max_amount, created_by, updated_by
    )
    VALUES (
      ${adminUserId}, ${periodType}::limit_period_type, ${maxAmount},
      ${setBy}, ${setBy}
    )
    ON CONFLICT (admin_user_id, period_type) DO UPDATE SET
      max_amount = EXCLUDED.max_amount,
      updated_by = EXCLUDED.updated_by,
      updated_at = NOW()
    RETURNING *
  `);

  await createAdminAuditEvent({
    adminUserId: setBy,
    eventType: "balance_limit_updated",
    targetUserId: adminUserId,
    metadata: { periodType, maxAmount },
  });

  return result.rows[0];
}

export async function deleteLimit(
  adminUserId: string,
  periodType: limit_period_type,
  deletedBy: string
) {
  const deleted = await adminDrizzle.execute(sql`
    DELETE FROM admin_balance_limits
    WHERE admin_user_id = ${adminUserId}
      AND period_type = ${periodType}::limit_period_type
    RETURNING id
  `);
  if (deleted.rows.length === 0) {
    throw new Error("Balance limit not found");
  }

  await createAdminAuditEvent({
    adminUserId: deletedBy,
    eventType: "balance_limit_deleted",
    targetUserId: adminUserId,
    metadata: { periodType },
  });
}
