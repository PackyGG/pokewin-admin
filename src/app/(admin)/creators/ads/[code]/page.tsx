import { redirect, RedirectType } from "next/navigation";

import { requirePageAccess } from "@/lib/dal";

/** Legacy ad-detail bookmark — roster lives on /creators. */
export default async function CreatorsAdDetailRedirect() {
  await requirePageAccess("/creators");
  redirect("/creators", RedirectType.replace);
}
