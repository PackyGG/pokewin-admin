import { notFound, redirect, RedirectType } from "next/navigation";

import { requirePageAccess } from "@/lib/dal";
import { queryMainRows } from "@/lib/drizzle-query";
import { safeQuery } from "@/lib/errors/safe-query";

/** Legacy code detail bookmark → owning creator profile. */
export default async function CreatorCodeDetailRedirect({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  await requirePageAccess("/creators");
  const { code } = await params;

  // This route only needs the code's OWNER to redirect. It used to call
  // `getCodeAnalytics()`, which fires a 9-way Promise.all of heavy analytics
  // (referral aggregate, daily series, country breakdown, hourly/daily
  // acquisition) and then threw all of it away — every one of those queries
  // ran on a page that renders nothing. This is the single lookup that
  // function itself starts with, verbatim.
  //
  // Casing note (carried over from getCodeAnalytics): `affiliate_codes` rows
  // are MIXED case — migration 0068 backfilled legacy codes as-is — so the
  // lookup compares UPPER(ac.code) against the uppercased input. The JOIN on
  // "user" is dropped because only `user_id` is consumed here.
  const { data: rows } = await safeQuery(
    () =>
      queryMainRows<{ user_id: string }[]>(
        `SELECT ac.user_id
         FROM affiliate_codes ac
         WHERE UPPER(ac.code) = $1
         LIMIT 1`,
        code.toUpperCase(),
      ),
    [] as { user_id: string }[],
    "creators.codeOwner",
  );

  const ownerUserId = rows[0]?.user_id;
  if (!ownerUserId) notFound();
  // Must run BEFORE redirect() (which throws NEXT_REDIRECT). The served
  // payload is unchanged.
  redirect(`/creators/${ownerUserId}`, RedirectType.replace);
}
