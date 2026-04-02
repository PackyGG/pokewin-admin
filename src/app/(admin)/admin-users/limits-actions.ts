"use server";

import { requireAdmin } from "@/lib/dal";
import {
  getAllLimits,
  getLimitsForAdmin,
  setLimit,
  deleteLimit,
} from "@/lib/balance-limits";
import type { limit_period_type } from "@/generated/admin-prisma/client";

export async function getAdminLimits() {
  await requireAdmin();
  return getAllLimits();
}

export async function getAdminUserLimits(adminUserId: string) {
  await requireAdmin();
  return getLimitsForAdmin(adminUserId);
}

export async function setAdminLimit(data: {
  adminUserId: string;
  periodType: limit_period_type;
  maxAmount: number;
}) {
  const session = await requireAdmin();
  return setLimit({
    adminUserId: data.adminUserId,
    periodType: data.periodType,
    maxAmount: data.maxAmount,
    setBy: session.userId,
  });
}

export async function deleteAdminLimit(
  adminUserId: string,
  periodType: limit_period_type
) {
  const session = await requireAdmin();
  return deleteLimit(adminUserId, periodType, session.userId);
}
