import { redirect, RedirectType } from "next/navigation";

import { requirePageAccess } from "@/lib/dal";

/** Legacy balance-adjustments insights — removed from the admin dashboard. */
export default async function InsightsBalanceAdjustmentsRedirect() {
  await requirePageAccess("/insights/balance-adjustments");
  redirect("/insights/analytics", RedirectType.replace);
}
