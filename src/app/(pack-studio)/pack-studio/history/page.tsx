import { Suspense } from "react";
import { redirect } from "next/navigation";
import { History } from "lucide-react";

import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { EmptyState } from "@/components/empty-state";
import { TableSkeleton } from "@/components/loading-skeletons";
import { FadeIn } from "@/components/fade-in";
import { requirePackStudioPageAccess } from "@/lib/require-pack-studio-access";
import { isOwner } from "@/lib/owners";
import { isUuid } from "@/lib/utils/ids";
import { getPackHistory } from "../_lib/pack-history";
import { getPackMetaByIds } from "../_lib/pack-meta";
import { HistoryTimeline, type HistoryRow } from "./history-timeline";
import { HistoryPackFilter, type PackOption } from "./history-pack-filter";

/**
 * Pack Studio — Change History + revert. Owner-only timeline of every captured
 * `pack_state_snapshots` row (ADMIN DB, newest first) joined to live pack
 * identity (MAIN, read-only batch read). Each entry shows what state the pack
 * was in BEFORE a write (its price + a compact risk summary) and offers a
 * 2FA-guarded "Revert to this state" that re-writes the live pack — the same
 * blast radius as a retune, delegated to the existing paranoid
 * `revertPackToSnapshot` action.
 *
 * Shell-first: the hero + pack picker paint immediately while the timeline
 * streams behind a `<Suspense>` keyed on the active pack filter (see
 * `loading.tsx` for the matching skeleton). The reads are owner-gated by
 * `requirePackStudioPageAccess` + an explicit owner check at the top.
 *
 * Dual-DB discipline: `getPackHistory` reads ADMIN only; `getPackMetaByIds`
 * reads MAIN read-only (an `id = ANY(...)` PK probe). No MAIN writes happen on
 * this page — the only write is the operator-confirmed revert, which runs
 * through `revertPackToSnapshot` (owner + 2FA token, fail-closed).
 */

// The history list is bounded (HISTORY_MAX_LIMIT = 200) and resolves pack
// identity in one batched MAIN read, but give the route a little headroom for
// the remote ADMIN-DB read on a cold serverless connection.
export const maxDuration = 60;

// Newest 200 snapshots across all packs (the lib's hard cap). Enough to both
// populate the pack picker and render the unfiltered timeline; a per-pack view
// re-reads scoped to that pack.
const TIMELINE_LIMIT = 200;

type SearchParams = Record<string, string | string[] | undefined>;

function readOne(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Resolve the active pack filter from `?pack=<id>`. Only a valid uuid is honored
 * — anything else (incl. an absent param) means "all packs".
 */
function activePackId(sp: SearchParams): string | undefined {
  const raw = readOne(sp.pack);
  return raw && isUuid(raw) ? raw : undefined;
}

async function HistoryStream({ packId }: { packId: string | undefined }) {
  // Always read the unfiltered head so the pack picker stays populated with
  // every pack that has history (the picker must not collapse to a single pack
  // just because the timeline is currently scoped). The scoped timeline then
  // reads only the selected pack's snapshots.
  const allSnapshots = await getPackHistory(undefined, TIMELINE_LIMIT);
  const snapshots = packId
    ? await getPackHistory(packId, TIMELINE_LIMIT)
    : allSnapshots;

  // One batched MAIN read for the union of pack ids across BOTH lists, so the
  // timeline rows and the picker options share resolved identity.
  const packIds = Array.from(
    new Set([
      ...allSnapshots.map((s) => s.packId),
      ...snapshots.map((s) => s.packId),
    ]),
  );
  const meta = await getPackMetaByIds(packIds);

  // Pack picker options: one entry per pack that has history, sorted by name.
  const seen = new Set<string>();
  const packOptions: PackOption[] = [];
  for (const s of allSnapshots) {
    if (seen.has(s.packId)) continue;
    seen.add(s.packId);
    const m = meta.get(s.packId);
    packOptions.push({
      packId: s.packId,
      name: m?.name ?? `${s.packId.slice(0, 8)}…`,
    });
  }
  packOptions.sort((a, b) => a.name.localeCompare(b.name));

  if (snapshots.length === 0) {
    return (
      <div className="rounded-md border">
        <EmptyState
          icon={History}
          title={packId ? "No history for this pack" : "No change history yet"}
          description={
            packId
              ? "This pack has no captured snapshots. A snapshot is recorded automatically before each retune, reprice, edit, or revert."
              : "Snapshots are captured automatically before a pack's price or weights change (retune, reprice, edit, or revert). Once a pack changes, its prior state appears here."
          }
        />
      </div>
    );
  }

  const rows: HistoryRow[] = snapshots.map((s) => {
    const m = meta.get(s.packId);
    return {
      id: s.id,
      packId: s.packId,
      packName: m?.name ?? `${s.packId.slice(0, 8)}…`,
      packSlug: m?.slug ?? null,
      // The pack's CURRENT live price/active, for context against the snapshot.
      currentPrice: m?.price ?? null,
      packActive: m?.active ?? null,
      action: s.action,
      capturedAt: s.capturedAt,
      capturedBy: s.capturedBy,
      price: s.price,
      cardCount: s.cards.length,
      note: s.note,
      risk: s.risk
        ? {
            edge: s.risk.edge,
            cv: s.risk.cv,
            winRate: s.risk.winRate,
            maxWin: s.risk.maxWin,
            maxMult: s.risk.maxMult,
            tier: s.risk.tier,
          }
        : null,
    };
  });

  return (
    <FadeIn>
      <HistoryPackFilter options={packOptions} />
      <HistoryTimeline rows={rows} />
    </FadeIn>
  );
}

export default async function PackHistoryPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await requirePackStudioPageAccess();
  // Owner-only surface: the page reads + the revert write are restricted to the
  // owner (the revert action re-checks owner + 2FA server-side, but we also
  // hide the whole page from non-owners). A non-owner who reaches this route is
  // bounced to the Studio overview.
  if (!isOwner(session)) {
    redirect("/pack-studio");
  }

  const sp = await searchParams;
  const packId = activePackId(sp);

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={History}
          accent="amber"
          title="Change History"
          subtitle="Review every captured pack state and revert a pack to an earlier price + odds."
        />
      </PageHero>

      <div className="space-y-3">
        <SectionHeading icon={History} title="Captured snapshots" />
        <Suspense
          key={packId ?? "all"}
          fallback={<TableSkeleton rows={8} columns={5} />}
        >
          <HistoryStream packId={packId} />
        </Suspense>
      </div>
    </div>
  );
}
