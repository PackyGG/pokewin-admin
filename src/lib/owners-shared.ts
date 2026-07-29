/**
 * Edge-safe owner primitives, shared with the middleware layer.
 *
 * `src/lib/owners.ts` is the full owner module (the central source of truth
 * for the owner tier), but it pulls in the ADMIN-DB client and
 * `next/navigation`, so the Edge middleware — and the dependency-free
 * `app-hosts.ts` host map it imports — cannot use it. The root-owner username
 * therefore lives HERE (pure constants/functions only: no node imports, no DB,
 * no `server-only`) and `owners.ts` re-exports it, so there is still exactly
 * ONE definition and the literal never re-scatters into the edge layer.
 */

/**
 * The permanent ROOT / MAIN owner username. Hard-coded, lowercase. This account
 * is ALWAYS an owner (DB-independent) and is the ONLY account that can manage
 * the owner list. Matches the case-insensitive `motha` checks the old
 * per-feature gates used.
 */
export const MAIN_OWNER_USERNAME = "motha";

/**
 * True when a raw username is the permanent root owner. Pure + synchronous
 * (trim/lowercase compare) so middleware and the host map can call it without
 * touching the DB-backed `is_owner` flag.
 */
export function isRootOwnerUsername(
  username: string | null | undefined,
): boolean {
  return (username ?? "").trim().toLowerCase() === MAIN_OWNER_USERNAME;
}
