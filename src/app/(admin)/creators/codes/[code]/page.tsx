import { notFound, redirect, RedirectType } from "next/navigation";

import { requirePageAccess } from "@/lib/dal";
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
  redirect(`/creators/${data.ownerUserId}`, RedirectType.replace);
}
