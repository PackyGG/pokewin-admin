import { redirect, RedirectType } from "next/navigation";

import { requirePageAccess } from "@/lib/dal";

/** Legacy signup rewards insights — folded into /insights/rewards categories. */
export default async function InsightsSignupRewardsRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/insights/rewards/signup");
  const params = await searchParams;
  const period = params.period;
  const qs = new URLSearchParams({ tab: "categories" });
  if (period) qs.set("period", period);
  redirect(`/insights/rewards?${qs.toString()}`, RedirectType.replace);
}
