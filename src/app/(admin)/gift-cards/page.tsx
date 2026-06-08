import { redirect, RedirectType } from "next/navigation";

import { requirePageAccess } from "@/lib/dal";

/** Legacy gift-cards list — removed from the admin dashboard. */
export default async function GiftCardsRedirect() {
  await requirePageAccess("/rewards");
  redirect("/rewards", RedirectType.replace);
}
