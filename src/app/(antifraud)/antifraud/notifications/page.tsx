import { redirect } from "next/navigation";

import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";

/**
 * Legacy workspace route. The inbox now belongs to the shared dashboard
 * system, so old bookmarks leave the Anti-Fraud host and land on the canonical
 * System page.
 */
export default async function LegacyAntifraudNotificationsPage() {
  await requireAntifraudPageAccess();
  redirect("/system/staff-notifications");
}
