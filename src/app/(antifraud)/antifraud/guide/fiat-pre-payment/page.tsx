import { redirect } from "next/navigation";

import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";

export const metadata = { title: "Fiat Deposits Guide · Antifraud" };

/**
 * The pre-payment gate is now stage 1 of the end-to-end fiat guide rather than
 * a page of its own — reading it in isolation was how the "allow is valid for
 * 60 seconds" misconception survived. Kept as a redirect so existing links and
 * bookmarks still land somewhere correct.
 */
export default async function AntifraudFiatPrePaymentGuidePage() {
  await requireAntifraudPageAccess();
  redirect("/antifraud/guide/fiat-deposits");
}
