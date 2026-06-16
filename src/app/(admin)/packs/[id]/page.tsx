import { notFound } from "next/navigation";
import {
  getUserPermissions,
  requirePageAccess,
  sessionHasRole,
} from "@/lib/dal";
import { hasCapability } from "@/app/(admin)/settings/roles/permissions-utils";
import { ensurePackCreatorCapabilities } from "@/lib/pack-creator/ensure-capabilities";
import { isUuid } from "@/lib/utils/ids";
import { safeQuery } from "@/lib/errors/safe-query";
import { PackDetailView } from "../pack-detail-view";
import { fetchPackFullDetail } from "../actions";

export const metadata = { title: "Pack Detail" };

export default async function PackDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await requirePageAccess("/packs");
  const { id } = await params;
  if (!isUuid(id)) notFound();

  const sp = await searchParams;
  const initialViewMode = sp.edit === "1" ? "edit" : "overview";

  await ensurePackCreatorCapabilities();

  const isAdmin = session.role === "admin";
  let canToggle = isAdmin;
  let canDelete = isAdmin;
  let canEdit = isAdmin;
  let canEditLive = isAdmin;
  if (!isAdmin) {
    const { data: perms } = await safeQuery(
      () => getUserPermissions(session.userId),
      [] as string[],
      "packs.detail.perms",
    );
    canToggle = hasCapability(perms, "__can_toggle_pack_active");
    canDelete = hasCapability(perms, "__can_delete_pack");
    canEdit = hasCapability(perms, "__can_update_pack");
    canEditLive = hasCapability(perms, "__can_edit_live_packs");
  }
  const isPackCreator = sessionHasRole(session, "pack_creator");

  // Prefetch the full detail (identity + economics + card pool + stats)
  // server-side so the page paints WITH data instead of mounting a skeleton and
  // then firing the client-side core→stats server-action waterfall after
  // hydration (each round-trip re-runs the page-access gate — especially slow on
  // cold prod functions). `fetchPackFullDetail` already wraps both reads in
  // safeQuery+timeout, so a slow scan still degrades gracefully; on any failure
  // we pass null and the client falls back to its own load()/retry flow.
  const initialPayload = await fetchPackFullDetail(id).catch(() => null);

  return (
    <PackDetailView
      packId={id}
      canToggle={canToggle}
      canDelete={canDelete}
      canEdit={canEdit}
      canEditLive={canEditLive}
      isPackCreator={isPackCreator}
      initialViewMode={initialViewMode}
      initialPayload={initialPayload}
    />
  );
}
