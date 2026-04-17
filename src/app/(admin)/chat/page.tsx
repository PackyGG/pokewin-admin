import { redirect } from "next/navigation";
import { verifySession, getUserPermissions, getDefaultRoute } from "@/lib/dal";

/**
 * Chat moderation is now a slide-out panel triggered from the admin shell
 * (see `src/components/chat-panel/`). The `/chat` key remains in ADMIN_PAGES
 * and gates panel access. This stub forwards any bookmarked `/chat` URL
 * hits to the user's default landing page.
 */
export default async function ChatLandingRedirect() {
  const session = await verifySession();
  const allowedPages = await getUserPermissions(session.userId);
  redirect(getDefaultRoute(session.role, allowedPages.filter((p) => p !== "/chat")));
}
