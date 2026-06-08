import { redirect, RedirectType } from "next/navigation";

import { requirePageAccess } from "@/lib/dal";

/** Legacy games insights — superseded by /ggr. */
export default async function InsightsGamesRedirect() {
  await requirePageAccess("/insights/games");
  redirect("/ggr", RedirectType.replace);
}
