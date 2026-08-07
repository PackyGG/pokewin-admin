/**
 * Per-user profile override: on this packy.gg user id, the admin detail
 * page shows ONLY balance adjustments made by the `motha` admin account.
 * All other admins' adjustments are hidden from financial feeds, the
 * dedicated adjustments block, and recent activity.
 */
const MOTHA_ONLY_ADJUSTMENTS_USER_ID =
  "vqsEpQYADwxZ421j2aCV87R2qyIkN6Zd";

export function isMothaOnlyAdjustmentsProfile(userId: string): boolean {
  return userId === MOTHA_ONLY_ADJUSTMENTS_USER_ID;
}
