import { redirect, RedirectType } from "next/navigation";

import { requirePageAccess } from "@/lib/dal";

/** Legacy ads list — removed from the admin dashboard. */
export default async function CreatorsAdsRedirect() {
  await requirePageAccess("/creators");
  redirect("/creators", RedirectType.replace);
}
