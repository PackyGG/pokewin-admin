import { adminDb } from "@/lib/admin-db";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { getRoleBalanceLimitDefaults } from "@/lib/role-limits";
import {
  resolveEffectiveCap,
  type RoleBalanceLimitDefaults,
} from "@/lib/role-limits-merge";
import type { limit_period_type } from "@/generated/admin-prisma/client";

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

  const events = await adminDb.admin_audit_events.findMany({
    where: {
      admin_user_id: adminUserId,
      event_type: { in: ["balance_adjustment", "manual_withdrawal_recorded"] },
      created_at: { gte: periodStart },
    },
    select: { metadata: true },
  });

  let currentUsage = 0;
  for (const event of events) {
    const meta = event.metadata as Record<string, unknown> | null;
    if (!meta) continue;
    // Accept either field — `amount` for balance_adjustment events,
    // `amountUsd` for manual_withdrawal_recorded events.
    if (typeof meta.amount === "number") {
      currentUsage += Math.abs(meta.amount);
    } else if (typeof meta.amountUsd === "number") {
      currentUsage += Math.abs(meta.amountUsd);
    }
  }
  return currentUsage;
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
  const userLimits = await adminDb.admin_balance_limits.findMany({
    where: { admin_user_id: adminUserId },
  });
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
  return adminDb.admin_balance_limits.findMany({
    where: { admin_user_id: adminUserId },
  });
}

export async function getAllLimits() {
  const limits = await adminDb.admin_balance_limits.findMany({
    orderBy: { created_at: "desc" },
  });

  const adminIds = [...new Set(limits.map((l) => l.admin_user_id))];
  const admins = adminIds.length > 0
    ? await adminDb.admin_users.findMany({
        where: { id: { in: adminIds } },
        select: { id: true, username: true, email: true },
      })
    : [];

  const adminMap = new Map(admins.map((a) => [a.id, a]));

  return limits.map((l) => ({
    ...l,
    adminUsername: adminMap.get(l.admin_user_id)?.username ?? "Unknown",
    adminEmail: adminMap.get(l.admin_user_id)?.email ?? "Unknown",
  }));
}

export async function setLimit(params: {
  adminUserId: string;
  periodType: limit_period_type;
  maxAmount: number;
  setBy: string;
}) {
  const { adminUserId, periodType, maxAmount, setBy } = params;

  const result = await adminDb.admin_balance_limits.upsert({
    where: {
      admin_user_id_period_type: {
        admin_user_id: adminUserId,
        period_type: periodType,
      },
    },
    update: {
      max_amount: maxAmount,
      updated_by: setBy,
      updated_at: new Date(),
    },
    create: {
      admin_user_id: adminUserId,
      period_type: periodType,
      max_amount: maxAmount,
      created_by: setBy,
      updated_by: setBy,
    },
  });

  await createAdminAuditEvent({
    adminUserId: setBy,
    eventType: "balance_limit_updated",
    targetUserId: adminUserId,
    metadata: { periodType, maxAmount },
  });

  return result;
}

export async function deleteLimit(
  adminUserId: string,
  periodType: limit_period_type,
  deletedBy: string
) {
  await adminDb.admin_balance_limits.delete({
    where: {
      admin_user_id_period_type: {
        admin_user_id: adminUserId,
        period_type: periodType,
      },
    },
  });

  await createAdminAuditEvent({
    adminUserId: deletedBy,
    eventType: "balance_limit_deleted",
    targetUserId: adminUserId,
    metadata: { periodType },
  });
}
