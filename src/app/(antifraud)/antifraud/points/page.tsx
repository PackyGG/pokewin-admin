import { redirect } from "next/navigation";

import { requireAntifraudManagerPage } from "@/lib/require-antifraud-access";

export const metadata = { title: "Rules & Scoring · Antifraud" };

/**
 * Risk scoring and the flow builder are tabs on the Fraud Settings page now.
 * The old `?tab=flows` deep-link is preserved rather than dropped on the floor:
 * it was the link the built-in automation catalog and the flow editor handed
 * out, so it must keep landing on the builder.
 */
export default async function AntifraudPointsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  await requireAntifraudManagerPage();
  const requested = (await searchParams).tab;
  redirect(
    requested === "flows"
      ? "/antifraud/settings?tab=flows"
      : "/antifraud/settings?tab=scoring",
  );
}
