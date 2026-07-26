import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { hrefFrom, resolveAppHost } from "@/lib/app-hosts";
import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";

/**
 * Legacy workspace route. The inbox now belongs to the shared dashboard
 * system, so old bookmarks leave the Anti-Fraud host and land on the canonical
 * System page.
 */
export default async function LegacyAntifraudNotificationsPage() {
  await requireAntifraudPageAccess();
  const host = (await headers()).get("host") ?? "";
  redirect(
    hrefFrom(resolveAppHost(host), "/system/staff-notifications"),
  );
}
