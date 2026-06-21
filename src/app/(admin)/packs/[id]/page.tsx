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
import { fetchPackListSeed } from "../actions";

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

  // SHELL-FIRST STREAMING: do NOT prefetch the heavy reads at the top level.
  // `getPackDetail` (identity + full card pool) and especially `getPackStats`
  // (two `result_metadata->>'pack_id'` scans over provably_fair_results) used to
  // be awaited here, blocking first paint. The scans themselves are fast — both
  // hit `idx_pf_result_metadata_pack_id_created_at` via Bitmap Index Scan
  // (~21ms / ~8ms, verified read-only on prod) — but awaiting them in the
  // Server Component body blocks the render, and with ~10 /packs/[id] tabs
  // opening at once those awaits contend the shared MAIN connection pool
  // (max:3), so the renders serialize and time out ("takes ages / barely
  // loads"). This is the same pool-contention signature as the 2026-06-14
  // withdrawals incident, and it violates the binding shell-first rule.
  //
  // `PackDetailView` already implements the shell-first flow for
  // `initialPayload === null`: it paints the PageHero shell immediately
  // (seeding the header from the lightweight `fetchPackListSeed` PK lookup),
  // client-loads the core detail behind `DetailBodySkeleton`, then auto-loads
  // `getPackStats` SEPARATELY behind its own skeleton (the `statsAutoLoadedFor`
  // effect). `loading.tsx` renders the same shell + skeletons. So we hand it
  // `null` and let the client stream the data in.

  // Auto edit mode: open straight into the editor when this user is actually
  // allowed to edit THIS pack (mirrors the `showEditButton` gate in the view —
  // a pack_creator can only edit inactive packs unless they have live-edit).
  // `?edit=0` forces overview, `?edit=1` forces edit; otherwise default to edit
  // for editors so there's no extra click.
  //
  // The pack_creator carve-out needs the pack's `active` flag. Rather than pull
  // the heavy `getPackDetail` just for one boolean (which would re-block first
  // paint), read it from the lightweight `fetchPackListSeed` — a single
  // indexed-PK `findUnique` with a narrow select (no card pool, no JSONB scan).
  // For admins / non-pack-creators (and pack_creators with live-edit) the flag
  // can't change the gate, so the seed is only fetched when it actually matters.
  let packActive: boolean | null = null;
  if (canEdit && isPackCreator && !canEditLive) {
    const { data: seed } = await safeQuery(
      () => fetchPackListSeed(id),
      null,
      "packs.detail.seed",
    );
    packActive = seed?.active ?? null;
  }
  const canEditThisPack =
    canEdit && (!isPackCreator || !packActive || canEditLive);
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
      initialPayload={null}
    />
  );
}
