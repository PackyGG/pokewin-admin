import { redirect } from "next/navigation";
import type { SessionPayload } from "@/lib/session";
import { verifySession } from "@/lib/dal";

/**
 * Access to the Top Chatters leaderboard is restricted to a hard-coded
 * two-username allowlist — NOT gated by role, `allowed_pages`, or the
 * generic admin/owner bypass (`requirePageAccess` lets every admin/owner
 * through, which is too wide here). Mirrors the strict shape of
 * `src/lib/excluded-users/gate.ts` (root-owner-only), sized to two names
 * instead of one. Hard-coded (not DB-fetched) so widening access requires a
 * deploy, same rationale as `PACK_STUDIO_RETUNE_OPERATOR_USERNAMES` in
 * `src/lib/reprice-access.ts`.
 */
const TOP_CHATTERS_ALLOWED_USERNAMES: readonly string[] = ["motha", "hifoen"];

function normalizeUsername(username: string | null | undefined): string {
  return (username ?? "").trim().toLowerCase();
}

/** True iff this session's username is on the Top Chatters allowlist. Strict
 *  — the generic admin/owner bypass does NOT apply here. */
export function isTopChattersViewer(
  session: Pick<SessionPayload, "username">,
): boolean {
  return TOP_CHATTERS_ALLOWED_USERNAMES.includes(normalizeUsername(session.username));
}

/**
 * Throwing server-side gate for the Top Chatters page — redirects to
 * /dashboard for anyone whose username isn't on the allowlist, including
 * other admins and owners.
 */
export async function requireTopChattersAccess(): Promise<
  SessionPayload & { username: string }
> {
  const session = await verifySession();
  if (!isTopChattersViewer(session)) {
    redirect("/dashboard");
  }
  return { ...session, username: session.username };
}
