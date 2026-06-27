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

/**
 * Trusted-operator allowlist for the Pack-Studio re-tune surface.
 *
 * Hard-coded (NOT DB-fetched) so the only way to add or remove an entry is a
 * deploy — a DB blip can never silently widen who can run a retune. Same shape
 * as the permanent `MAIN_OWNER_USERNAME` in `src/lib/owners.ts`: a string
 * literal, lowercased, checked case-insensitively.
 *
 * Operators in this list:
 *   • pass `isPackStudioRetuneOperator` exactly like an owner — they can reach
 *     the read-only Pack-Studio retune dry-runs (`planPackRetune`,
 *     `planAllRetunes`, `planCustomRepin`, `getPortfolioProfile`,
 *     `getPackRetunePool`, `getPackEditPool`, `getRetunePickerFilters`);
 *   • can MINT a retune / re-price token via `authorizePackRetune` /
 *     `authorizeReprice` WITHOUT proving 2FA (owners still have to);
 *   • can run every authoritative write that gates on this predicate
 *     (`applyPackRetune`, `repricePackToTargetEdge`, `applyPackEdit`,
 *     `applyStagedPackEditAndRetune`, `revertPackToSnapshot`, `buildPack`).
 *
 * Every action still writes `admin_audit_events` keyed to the operator's own
 * admin user id, so the audit trail attributes the change to the operator (not
 * to an owner). The audit metadata also flags the 2FA-bypass path so a review
 * can separate operator-no-2FA writes from owner-with-2FA writes.
 *
 * The global `/packs` re-price BUTTON visibility still gates on
 * `isRepriceOwner` (owners only) so operators in this list do not see it on
 * `/packs` — they reach the same `authorizeReprice` /
 * `repricePackToTargetEdge` actions via the Pack-Studio "Re-pin" flow.
 */
const PACK_STUDIO_RETUNE_OPERATOR_USERNAMES: readonly string[] = ["demee"];

function normalizeUsername(username: string | null | undefined): string {
  return (username ?? "").trim().toLowerCase();
}

/**
 * True iff the session is allowed to use the Pack-Studio re-tune tools.
 * Owners always pass; the hard-coded operator allowlist above passes too.
 * Pure + synchronous so it can be reused verbatim by route guards, server
 * actions, and client-side UI gates that already hold a session shape.
 */
export function isPackStudioRetuneOperator(
  session: Pick<SessionPayload, "username" | "isOwner">,
): boolean {
  if (isOwner(session)) return true;
  const username = normalizeUsername(session.username);
  if (!username) return false;
  return PACK_STUDIO_RETUNE_OPERATOR_USERNAMES.includes(username);
}

/**
 * True iff the operator predicate matched WITHOUT the session being an owner —
 * i.e. the caller is on the hard-coded operator allowlist and is bypassing the
 * 2FA gate. The mint-token + apply-* actions consult this so they can flag the
 * bypass in `admin_audit_events.metadata.via_no_2fa_allowlist`. Owners stay on
 * the 2FA path and never hit this flag.
 */
export function isPackStudioRetuneOperatorNonOwner(
  session: Pick<SessionPayload, "username" | "isOwner">,
): boolean {
  if (isOwner(session)) return false;
  return isPackStudioRetuneOperator(session);
}
