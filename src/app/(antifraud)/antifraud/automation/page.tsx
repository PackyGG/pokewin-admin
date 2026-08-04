import { redirect } from "next/navigation";

import { requireAntifraudManagerPage } from "@/lib/require-antifraud-access";

export const metadata = { title: "Automation · Antifraud" };

/**
 * Automation is a tab on the Fraud Settings page now, not its own route. Kept
 * as a redirect so existing links, bookmarks and alert deep-links still land.
 */
export default async function AntifraudAutomationPage() {
  await requireAntifraudManagerPage();
  redirect("/antifraud/settings?tab=automation");
}
