import { redirect } from "next/navigation";

/**
 * Alerts moved to the right-rail dock (`DockedAlerts`). Redirect legacy
 * bookmarks to the Hub dashboard.
 */
export default function CreatorHubAlertsPage() {
  redirect("/creator-hub");
}
