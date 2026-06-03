import "server-only";

import { getDb } from "@/lib/db";
import { getUserCreatorHistory } from "@/lib/queries/user-role-history";

/**
 * creator-protection.ts — the SERVER-SIDE source of truth for whether a
 * user IS or WAS a creator, used to decide whether the creator-protected
 * wipe categories (creator deal/fill data, affiliate claims, affiliate
 * codes, deposits, withdrawals) are protected for THIS user.
 *
 * ─── THE POLICY (owner mandate, 2026-06-03) ─────────────────────────────
 *
 * The account-wipe protected set is no longer unconditional. It applies
 * ONLY when the target user IS or WAS a creator:
 *
 *   • IS / WAS a creator → the protected categories (creator deal/fill/data,
 *     affiliate_claims, affiliate codes, deposits, withdrawals) are
 *     DISABLED in the panel AND hard-rejected server-side even under a
 *     tampered request — they can NEVER be wiped for a creator/ex-creator.
 *   • NOT (and never) a creator → every category is selectable and wipeable.
 *
 * Default-protect EX-creators too (`wasCreator`) — the safer side: a former
 * creator's deal/affiliate/finance history is exactly the data the owner
 * never wants clawed back, and a demoted creator must not lose that
 * protection just because their current role flipped to `user`.
 *
 * ─── HOW "ever a creator" IS DERIVED (must match the user-detail page) ───
 *
 * This mirrors the EXACT signal the user-detail page already computes
 * (src/app/(admin)/users/[id]/page.tsx:451-455) and the /creators
 * past-creators list reuses (src/app/(admin)/creators/_queries/
 * list-ex-creators.ts):
 *
 *   everCreator = role === 'creator'
 *               OR everCreatorByAudit          (admin audit role_changed → creator)
 *               OR ownedCodes.length > 0       (affiliate_codes — a creator-only artifact)
 *   isCreator   = role === 'creator'
 *   wasCreator  = everCreator AND role !== 'creator'
 *
 * The three artifacts:
 *   1. Main DB — `user.role === 'creator'` (current role).
 *   2. Main DB — the user owns ≥1 `affiliate_codes` row. affiliate_codes is
 *      populated exclusively for creators (the backend createCode path), so
 *      owning one — even after a demotion — means they were a creator.
 *   3. Admin DB — an admin audit `role_changed` event whose
 *      `metadata.new_role === 'creator'` exists (getUserCreatorHistory).
 *
 * DUAL-DB (strict): `affiliate_codes` + `user.role` live in the Main DB; the
 * role-change audit trail lives in the Admin DB. Per the no-cross-DB-join
 * rule each side is queried independently and unioned in code.
 *
 * SECURITY: this is re-derived server-side inside every wipe action — never
 * trusted from a client-passed flag. A tampered request that omits/forges the
 * creator flag is irrelevant: the action recomputes it from the DBs and
 * hard-rejects a protected category if the user is an ever-creator.
 *
 * FAIL-CLOSED: if either side of the derivation throws, we treat the user as
 * an ever-creator (the protected, safer state) rather than exposing the
 * protected categories. A transient DB hiccup must never be what unlocks a
 * deposit/withdrawal/affiliate wipe.
 */

export type CreatorProtectionStatus = {
  /** Current role is exactly `creator`. */
  isCreator: boolean;
  /** Was a creator (audit role_changed→creator OR owns affiliate_codes) but is not one now. */
  wasCreator: boolean;
  /**
   * IS or WAS a creator — the flag that gates the protected categories.
   * `everCreator === isCreator || wasCreator`.
   */
  everCreator: boolean;
};

/**
 * Derive whether `userId` is or was a creator, dual-DB, server-side.
 *
 * Fail-closed: any error in the derivation returns the fully-protected state
 * (everCreator: true) so a DB hiccup can never expose a protected category.
 */
export async function getCreatorProtectionStatus(
  userId: string,
): Promise<CreatorProtectionStatus> {
  try {
    const db = await getDb();

    // Main DB — current role + whether they own any affiliate code (creator-
    // only artifact). One row + one cheap existence check, both keyed by the
    // indexed user_id.
    const [user, ownedCode] = await Promise.all([
      db.user.findUnique({ where: { id: userId }, select: { role: true } }),
      db.affiliate_codes.findFirst({
        where: { user_id: userId },
        select: { id: true },
      }),
    ]);

    // Admin DB — audit role_changed → creator. Already fail-soft internally
    // (returns { everCreatorByAudit: false } on its own error).
    const history = await getUserCreatorHistory(userId);

    const isCreator = user?.role === "creator";
    const everCreator =
      isCreator || history.everCreatorByAudit || ownedCode != null;
    const wasCreator = everCreator && !isCreator;

    return { isCreator, wasCreator, everCreator };
  } catch (err) {
    // Fail-closed: protect. A failure here must NOT unlock the protected
    // categories — better to refuse a legitimate non-creator wipe (the admin
    // can retry) than to allow a creator's deposits/withdrawals/affiliate
    // data to be wiped because a role read momentarily failed.
    console.error(
      "[getCreatorProtectionStatus] derivation failed — defaulting to PROTECTED (ever-creator):",
      err,
    );
    return { isCreator: false, wasCreator: true, everCreator: true };
  }
}
