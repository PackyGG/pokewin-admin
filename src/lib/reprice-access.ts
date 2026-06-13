import type { SessionPayload } from "@/lib/session";

/**
 * The ONLY admin allowed to see / use the global pack re-price tool.
 *
 * Owner rule (2026-06-14): the "Re-price → 10.99%" tool is visible to `motha`
 * and to nobody else — not even other full admins (there are ~13 active admin
 * accounts; this tool is the owner's alone). Gated on the server-signed session
 * username (`admin_users.username`, unique), so it can't be spoofed client-side.
 *
 * Used by BOTH the page (button visibility) and the server actions
 * (authoritative enforcement) so the two can never drift — hiding the button is
 * not security on its own.
 */
export const REPRICE_OWNER_USERNAME = "motha";

/** True iff this session belongs to the re-price owner. */
export function isRepriceOwner(session: Pick<SessionPayload, "username">): boolean {
  return (session.username ?? "").trim().toLowerCase() === REPRICE_OWNER_USERNAME;
}
