import { redirect } from "next/navigation";

import { requireCreatorHubPageAccess } from "./_lib/require-creator-hub-access";

export default async function CodesAdsIndexPage() {
  await requireCreatorHubPageAccess();
  redirect("/creator-hub/codes-ads/codes");
}
