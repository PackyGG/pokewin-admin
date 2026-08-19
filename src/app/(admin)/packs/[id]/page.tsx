import { notFound } from "next/navigation";

import { hasCapability } from "@/app/(admin)/settings/roles/permissions-utils";
import {
  getUserPermissions,
  requirePageAccess,
  sessionHasRole,
} from "@/lib/dal";
import { safeQuery } from "@/lib/errors/safe-query";
import { isUuid } from "@/lib/utils/ids";

import { PackDetailView } from "../pack-detail-view";

export const metadata = { title: "Pack Detail" };

export default async function PackDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requirePageAccess("/packs");
  const { id } = await params;
  if (!isUuid(id)) notFound();

  const isAdmin = session.role === "admin";
  let canToggle = isAdmin;
  let canDelete = isAdmin;
  let canEdit = isAdmin;
  let canEditLive = isAdmin;
  if (!isAdmin) {
    const { data: permissions } = await safeQuery(
      () => getUserPermissions(session.userId),
      [] as string[],
      "packs.detail.perms",
    );
    canToggle = hasCapability(permissions, "__can_toggle_pack_active");
    canDelete = hasCapability(permissions, "__can_delete_pack");
    canEdit = hasCapability(permissions, "__can_update_pack");
    canEditLive = hasCapability(permissions, "__can_edit_live_packs");
  }

  return (
    <PackDetailView
      packId={id}
      canToggle={canToggle}
      canDelete={canDelete}
      canEdit={canEdit}
      canEditLive={canEditLive}
      isPackCreator={sessionHasRole(session, "pack_creator")}
      initialPayload={null}
    />
  );
}
