import { redirect, RedirectType } from "next/navigation";

/**
 * Legacy hub ad-detail bookmark → admin marketing ad detail.
 */
export default async function CreatorHubAdDetailRedirect({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  redirect(`/creators/ads/${encodeURIComponent(code)}`, RedirectType.replace);
}
