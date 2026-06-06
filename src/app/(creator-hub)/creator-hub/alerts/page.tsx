import { redirect } from "next/navigation";

import { requireCreatorHubPageAccess } from "@/lib/require-creator-hub-access";

/**
 * Alerts moved to the right-rail dock (`DockedAlerts`). Redirect legacy
 * bookmarks to the Hub dashboard.
 */
export default async function CreatorHubAlertsPage() {
  await requireCreatorHubPageAccess();
  redirect("/creator-hub");
}
