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
import { fetchPackDetailCore } from "../actions";

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

  // Prefetch ONLY the fast core detail (identity + economics + card pool) so
  // the page paints immediately on navigation. The heavy `getPackStats` ("two
  // JSON scans") are deliberately NOT in this blocking path — they were what
  // made deep-linking into a pack feel like it hung. PackDetailView auto-loads
  // the stats client-side behind a skeleton (see its stats auto-load effect),
  // so the charts stream in after first paint instead of blocking it.
  // `fetchPackDetailCore` wraps the read in safeQuery+timeout; on failure we
  // pass null and the client falls back to its own load()/retry flow.
  const detail = await fetchPackDetailCore(id).catch(() => null);
  const initialPayload = detail ? { detail, stats: null } : null;

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
