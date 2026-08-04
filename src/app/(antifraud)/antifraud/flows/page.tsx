import { redirect } from "next/navigation";

import { requireAntifraudManagerPage } from "@/lib/require-antifraud-access";

export const metadata = { title: "Point Flows · Antifraud" };

/** The flow builder is the Point flows tab on Fraud Settings now. */
export default async function AntifraudFlowsPage() {
  await requireAntifraudManagerPage();
  redirect("/antifraud/settings?tab=flows");
}
