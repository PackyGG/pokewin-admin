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
import { fetchPackDetailCore, fetchPackDetailStats } from "../actions";

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

  // Prefetch the core detail (identity + economics + card pool) AND the chart
  // stats server-side. `getPackStats` was historically deferred to a client
  // round-trip because its two `result_metadata->>'pack_id'` scans were
  // unindexed full-scans; that index now exists on prod
  // (`idx_pf_result_metadata_pack_id_created_at`), so the scans run in ~130ms
  // and are cached 60s. Prefetching them here removes the separate client
  // `loadPackStats` request, which under the shared DB's small connection pool
  // (max:3) lost the connection race and timed out → the "Pack stats couldn't
  // load" fallback even though the query itself is fast (pool contention, not
  // the query — same signature as the 2026-06-14 withdrawals incident).
  // Both reads are safeQuery+timeout-wrapped (return null on genuine failure),
  // so a degraded scan still falls back to the client auto-load/retry flow.
  const detail = await fetchPackDetailCore(id).catch(() => null);
  const stats = detail
    ? await fetchPackDetailStats(id, detail).catch(() => null)
    : null;
  const initialPayload = detail ? { detail, stats } : null;

  // Auto edit mode: open straight into the editor when this user is actually
  // allowed to edit THIS pack (mirrors the `showEditButton` gate in the view —
  // a pack_creator can only edit inactive packs unless they have live-edit).
  // `?edit=0` forces overview, `?edit=1` forces edit; otherwise default to
  // edit for editors so there's no extra click.
  const canEditThisPack =
    canEdit && detail != null && (!isPackCreator || !detail.active || canEditLive);
  const initialViewMode: "edit" | "overview" =
    sp.edit === "0"
      ? "overview"
      : sp.edit === "1"
        ? "edit"
        : canEditThisPack
          ? "edit"
          : "overview";

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
