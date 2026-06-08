import { redirect, RedirectType } from "next/navigation";

import { requirePageAccess } from "@/lib/dal";

/** Legacy affiliate-codes list — roster lives on /creators. */
export default async function CreatorsCodesRedirect() {
  await requirePageAccess("/creators");
  redirect("/creators", RedirectType.replace);
}
