import { redirect } from "next/navigation";
import { verifySession, getUserPermissions, getDefaultRoute } from "@/lib/dal";

/**
 * The /chat route is kept as a landing redirect — chat moderation is now a
 * slide-out panel triggered from the admin shell (see
 * `src/components/chat-panel/`). The capability key `/chat` still gates who
 * can open that panel, so we don't remove it from ADMIN_PAGES.
 *
 * Why this stub exists:
 *   - `src/middleware.ts` redirects support/marketing to `/chat` after login.
 *   - `src/lib/admin-roles.ts` (getDefaultRoute) falls back to `/chat` when
 *     a non-admin/creator user has no allowed_pages entries.
 * Both files are on the avoid-list for this task, so we cannot rewire those
 * defaults here. This stub forwards users to the first page they're allowed
 * to see instead of 404-ing.
 */
export default async function ChatLandingRedirect() {
  const session = await verifySession();
  const allowedPages = await getUserPermissions(session.userId);
  redirect(getDefaultRoute(session.role, allowedPages.filter((p) => p !== "/chat")));
}
