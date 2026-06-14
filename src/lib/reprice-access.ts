import type { SessionPayload } from "@/lib/session";
import { isOwner } from "@/lib/owners";

/**
 * Access to the global pack re-price tool is now OWNER-gated (was `motha`-only
 * by username). Visible to any owner and to nobody else — not even other full
 * admins. Gated on the server-verified session (`isOwner` is read DB-fresh by
 * verifySession; the permanent `motha` username is owner regardless), so it
 * can't be spoofed client-side.
 *
 * Used by BOTH the page (button visibility) and the server actions
 * (authoritative enforcement) so the two can never drift — hiding the button is
 * not security on its own.
 */

/** True iff this session belongs to an owner (the re-price tool owner). */
export function isRepriceOwner(
  session: Pick<SessionPayload, "username" | "isOwner">,
): boolean {
  return isOwner(session);
}
