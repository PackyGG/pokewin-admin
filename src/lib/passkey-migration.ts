/**
 * The 2026-07-26 passkey RP-ID cutover.
 *
 * WHAT HAPPENED: the dashboard moved from a single host
 * (`pokewin-admin.vercel.app`) to four `packydash.com` hosts. A passkey is
 * bound to the RP ID it was created under, and the browser will only offer it
 * on that exact domain or a registrable parent — so with four hostnames the RP
 * ID had to become the shared parent, `packydash.com` (see `webauthn.ts` for
 * why nothing else works).
 *
 * THE CONSEQUENCE: every credential registered BEFORE that change is bound to
 * the old RP ID and can never be used again. It isn't broken or revoked — it's
 * simply for a different domain, and the browser won't even show it.
 *
 * WHY A TIMESTAMP AND NOT A COLUMN: `admin_passkeys` never stored an rp_id, so
 * there is nothing in the row to compare. But the cutover was a single instant
 * that applies to EVERY credential equally — anything created before it is
 * stale, anything after is fine. A constant is therefore exactly as precise as
 * a column would be, needs no migration, and needs no backfill. (If the RP ID
 * ever moves again, bump this and the same logic covers it.)
 *
 * NOBODY IS LOCKED OUT BY THIS. Passkeys are the ALTERNATIVE second factor;
 * TOTP is the primary and is account-bound, not domain-bound, so it keeps
 * working. Removing a dead passkey and enrolling a new one both require only a
 * verified session (`verifySession`) — no passkey assertion — so the recovery
 * path can't depend on the thing that's broken.
 *
 * Isomorphic on purpose: the profile card and the 2FA form are both Client
 * Components.
 */

/**
 * The instant the RP ID changed to `packydash.com`. Credentials created before
 * this are bound to the previous domain.
 *
 * Deliberately a couple of hours before the actual deploy: erring EARLY only
 * ever shows a "re-add this" hint on a credential that might still work, which
 * is harmless. Erring late would stay silent on one that definitely doesn't.
 */
const PASSKEY_RP_CUTOVER_ISO = "2026-07-26T00:00:00.000Z";

const CUTOVER_MS = Date.parse(PASSKEY_RP_CUTOVER_ISO);

/**
 * True if a credential created at `createdAt` predates the cutover and is
 * therefore bound to the old domain.
 *
 * Unparseable input returns false — an unreadable date should not scare someone
 * into deleting a working credential.
 */
export function isPasskeyFromOldDomain(
  createdAt: string | Date | null | undefined,
): boolean {
  if (!createdAt) return false;
  const ms =
    createdAt instanceof Date ? createdAt.getTime() : Date.parse(createdAt);
  if (!Number.isFinite(ms)) return false;
  return ms < CUTOVER_MS;
}

/** Shown wherever a stale credential is listed. */
const PASSKEY_STALE_TITLE = "Registered on the old domain";

export const PASSKEY_STALE_BODY =
  "This passkey was created before the dashboard moved to packydash.com, so " +
  "your browser can't offer it here anymore. Remove it and add a new one — " +
  "it takes a few seconds. Your authenticator app still works as normal in " +
  "the meantime.";

/**
 * What to tell someone whose passkey sign-in just failed. Sign-in can't know
 * WHICH credential was attempted (the browser picks), so this is phrased as the
 * likely cause plus the guaranteed-working way in.
 */
export const PASSKEY_SIGNIN_FAILED_HINT =
  "If this passkey was set up before the move to packydash.com it no longer " +
  "works on this domain. Sign in with your authenticator code below, then " +
  "remove and re-add the passkey from your profile.";

export const PASSKEY_DIRECT_SIGNIN_FAILED_HINT =
  "Older passkeys may not be discoverable, and passkeys created before the " +
  "move to packydash.com no longer work on this domain. Sign in with email " +
  "and password, then remove and re-add the passkey from your profile.";
