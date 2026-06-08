import { redirect, RedirectType } from "next/navigation";

import { requirePageAccess } from "@/lib/dal";

/**
 * Legacy bookmark for the standalone Raw P&L page — folded into
 * Analytics → Raw P&L tab.
 */
export default async function PurePnlRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/analytics/pure-pnl");
  const params = await searchParams;
  const qs = new URLSearchParams();
  qs.set("tab", "pure-pnl");
  for (const [key, value] of Object.entries(params)) {
    if (value != null && key !== "tab") qs.set(key, value);
  }
  redirect(`/analytics?${qs.toString()}`, RedirectType.replace);
}
