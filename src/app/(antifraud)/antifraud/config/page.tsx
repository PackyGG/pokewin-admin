import { redirect } from "next/navigation";

import { requireAntifraudManagerPage } from "@/lib/require-antifraud-access";

export const metadata = { title: "Config · Antifraud" };

/**
 * The global Fiat auto-credit switch is a control on the Fraud Settings page's
 * Automation tab now. This route stays as a redirect so existing links land on
 * the control that used to live here.
 */
export default async function AntifraudConfigPage() {
  await requireAntifraudManagerPage();
  redirect("/antifraud/settings?tab=automation");
}
