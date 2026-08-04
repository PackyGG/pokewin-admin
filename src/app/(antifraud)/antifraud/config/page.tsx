import { redirect } from "next/navigation";

import { requireAntifraudManagerPage } from "@/lib/require-antifraud-access";

export const metadata = { title: "Config · Antifraud" };

/**
 * The global Fiat auto-credit switch moved into the Automation control center
 * (`?tab=controls`) — a single switch never justified its own nav entry and
 * page. This route stays as a redirect so existing links and bookmarks land on
 * the control that used to live here.
 */
export default async function AntifraudConfigPage() {
  await requireAntifraudManagerPage();
  redirect("/antifraud/automation?tab=controls");
}
