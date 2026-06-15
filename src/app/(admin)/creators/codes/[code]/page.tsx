import { notFound, redirect, RedirectType } from "next/navigation";

import { requirePageAccess } from "@/lib/dal";
import { compareCreatorCodeAnalytics } from "@/lib/clickhouse/compare/creators-code-analytics";
import { getCodeAnalytics } from "@/lib/queries/creators";

/** Legacy code detail bookmark → owning creator profile. */
export default async function CreatorCodeDetailRedirect({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  await requirePageAccess("/creators");
  const { code } = await params;
  const data = await getCodeAnalytics(code);
  if (!data?.ownerUserId) notFound();
  // Fire-and-forget ClickHouse comparison (no-op unless the
  // `creators_code_analytics` surface is in comparison mode). Must run BEFORE
  // redirect() (which throws NEXT_REDIRECT). The served payload is unchanged.
  void compareCreatorCodeAnalytics(code, data);
  redirect(`/creators/${data.ownerUserId}`, RedirectType.replace);
}
