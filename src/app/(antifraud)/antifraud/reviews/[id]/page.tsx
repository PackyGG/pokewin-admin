import { redirect } from "next/navigation";
import { z } from "zod";

import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";

export const metadata = { title: "Account Review" };

/**
 * Old case links now open the requested review on top of the queue. Keeping
 * this redirect preserves bookmarks and notification links without retaining
 * a separate operational page.
 */
export default async function LegacyReviewDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAntifraudPageAccess();
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) {
    redirect("/antifraud/reviews");
  }
  redirect(`/antifraud/reviews?review=${encodeURIComponent(id)}`);
}
