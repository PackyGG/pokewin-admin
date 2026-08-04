import { redirect } from "next/navigation";

import { requireAntifraudManagerPage } from "@/lib/require-antifraud-access";

export const metadata = { title: "Events & Triggers · Antifraud" };

/** The event catalog is the Events tab on Fraud Settings now. */
export default async function AntifraudEventsPage() {
  await requireAntifraudManagerPage();
  redirect("/antifraud/settings?tab=events");
}
