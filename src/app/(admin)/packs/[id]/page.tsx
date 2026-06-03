import { notFound, redirect } from "next/navigation";
import { requirePageAccess } from "@/lib/dal";
import { isUuid } from "@/lib/utils/ids";

export const metadata = { title: "Pack Detail" };

/**
 * /packs/[id] — there is NO standalone full-page pack view anymore. The pack
 * detail lives ENTIRELY in the centered modal on the /packs list (opened via
 * `?inspect=<id>`). This route exists only so direct URLs / external deep-links
 * keep working: it gates access exactly like the list, then `redirect`s to
 * /packs?inspect=<id> so the link lands on the list with the modal open.
 *
 * Auth gating is preserved (requirePageAccess("/packs")) so an unauthorised /
 * unpermitted hit is redirected by the DAL before we ever bounce to the list.
 * A malformed id (not a UUID) is a 404 rather than being forwarded into the
 * list URL as a stale `?inspect=` that matches no row.
 */
export default async function PackDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePageAccess("/packs");
  const { id } = await params;
  // Shape-check the UUID before forwarding it — see src/lib/utils/ids.ts.
  if (!isUuid(id)) notFound();
  redirect(`/packs?inspect=${id}`);
}
