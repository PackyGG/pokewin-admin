import { redirect } from "next/navigation";
import { verifySession, getUserPermissions, getDefaultRoute } from "@/lib/dal";

/**
 * Chat moderation currently has NO surface in the admin: the slide-out
 * chat panel (`src/components/chat-panel/`) lost its shell mount in the
 * right-rail rework and the dead tree + its server actions were removed
 * (2026-07-29). The `/chat` key remains in ADMIN_PAGES so existing role
 * grants stay recognized. This stub forwards any bookmarked `/chat` URL
 * hits to the user's default landing page.
 */
export default async function ChatLandingRedirect() {
  const session = await verifySession();
  const allowedPages = await getUserPermissions(session.userId);
  redirect(getDefaultRoute(session.role, allowedPages.filter((p) => p !== "/chat")));
}
