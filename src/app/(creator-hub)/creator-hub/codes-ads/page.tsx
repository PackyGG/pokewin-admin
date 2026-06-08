import { redirect, RedirectType } from "next/navigation";

/**
 * Legacy Creator Hub Codes & Ads bookmark — marketing surfaces live on
 * the main admin dashboard, not in Creator Hub.
 */
export default async function CreatorHubCodesAdsRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  if (params.tab === "codes") {
    redirect("/creators/codes", RedirectType.replace);
  }
  redirect("/creators/ads", RedirectType.replace);
}
