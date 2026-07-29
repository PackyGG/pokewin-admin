export const STAFF_WITHDRAWAL_REVIEW_EVENT_TYPES = [
  "locked_withdrawals_crypto_enabled",
  "locked_withdrawals_crypto_disabled",
  "locked_withdrawals_items_enabled",
  "locked_withdrawals_items_disabled",
] as const;

export type StaffWithdrawalReviewEventType =
  (typeof STAFF_WITHDRAWAL_REVIEW_EVENT_TYPES)[number];

export type StaffWithdrawalReviewEvent = {
  targetUserId: string | null;
  eventType: StaffWithdrawalReviewEventType;
  createdAt: string | Date;
};

type LatestEvents = Partial<Record<StaffWithdrawalReviewEventType, number>>;

/**
 * An account is "staff checked" only when both withdrawal channels were
 * locked and their latest lock was later cleared. A later re-lock removes the
 * mark until staff clears both channels again.
 */
export function getStaffCheckedWithdrawalUserIds(
  events: StaffWithdrawalReviewEvent[],
): string[] {
  const latestByUser = new Map<string, LatestEvents>();

  for (const event of events) {
    if (!event.targetUserId) continue;
    const occurredAt = new Date(event.createdAt).getTime();
    if (!Number.isFinite(occurredAt)) continue;

    const latest = latestByUser.get(event.targetUserId) ?? {};
    latest[event.eventType] = Math.max(
      latest[event.eventType] ?? Number.NEGATIVE_INFINITY,
      occurredAt,
    );
    latestByUser.set(event.targetUserId, latest);
  }

  return Array.from(latestByUser.entries())
    .filter(([, latest]) => {
      const cryptoEnabled =
        latest.locked_withdrawals_crypto_enabled ??
        Number.POSITIVE_INFINITY;
      const cryptoDisabled =
        latest.locked_withdrawals_crypto_disabled ??
        Number.NEGATIVE_INFINITY;
      const itemsEnabled =
        latest.locked_withdrawals_items_enabled ??
        Number.POSITIVE_INFINITY;
      const itemsDisabled =
        latest.locked_withdrawals_items_disabled ??
        Number.NEGATIVE_INFINITY;

      return (
        cryptoDisabled > cryptoEnabled &&
        itemsDisabled > itemsEnabled
      );
    })
    .map(([userId]) => userId);
}
