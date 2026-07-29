import "server-only";

import { and, inArray } from "drizzle-orm";

import {
  getStaffCheckedWithdrawalUserIds,
  STAFF_WITHDRAWAL_REVIEW_EVENT_TYPES,
  type StaffWithdrawalReviewEventType,
} from "@/lib/antifraud/withdrawal-review-status";
import { admin_audit_events } from "@/lib/db-schema/admin/schema";
import { adminDrizzle } from "@/lib/drizzle";

/**
 * Batch the account-level review history for the visible fiat-deposit page.
 * The source is ADMIN audit history, not the MAIN game database.
 */
export async function getFiatStaffCheckedWithdrawalUserIds(
  userIds: string[],
): Promise<string[]> {
  const distinctUserIds = Array.from(new Set(userIds)).filter(Boolean);
  if (distinctUserIds.length === 0) return [];

  const events = await adminDrizzle
    .select({
      targetUserId: admin_audit_events.target_user_id,
      eventType: admin_audit_events.event_type,
      createdAt: admin_audit_events.created_at,
    })
    .from(admin_audit_events)
    .where(
      and(
        inArray(admin_audit_events.target_user_id, distinctUserIds),
        inArray(admin_audit_events.event_type, [
          ...STAFF_WITHDRAWAL_REVIEW_EVENT_TYPES,
        ]),
      ),
    );

  return getStaffCheckedWithdrawalUserIds(
    events.map((event) => ({
      ...event,
      eventType: event.eventType as StaffWithdrawalReviewEventType,
    })),
  );
}
