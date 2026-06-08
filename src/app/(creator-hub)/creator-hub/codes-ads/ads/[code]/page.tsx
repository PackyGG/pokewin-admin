import { redirect, RedirectType } from "next/navigation";

/**
 * Legacy hub ad-detail bookmark — ads admin page removed; roster on /creators.
 */
export default async function CreatorHubAdDetailRedirect() {
  redirect("/creators", RedirectType.replace);
}
