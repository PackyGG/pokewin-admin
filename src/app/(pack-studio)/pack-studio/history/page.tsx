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
import { safeQueryOrNull } from "@/lib/errors/safe-query";
import { adminDb } from "@/lib/admin-db";
import { getPackHistory, getHistoryCardMeta } from "@/app/(admin)/packs/_lib/pack-history";
import { getPackMetaByIds } from "@/app/(admin)/packs/_lib/pack-meta";
import {
  HistoryTimeline,
  type HistoryRow,
  type HistoryCardRow,
} from "./history-timeline";
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

/** Resolved timeline payload — the pack-picker options + the rendered rows. */
type HistoryData = { packOptions: PackOption[]; rows: HistoryRow[] };

/**
 * Read + shape the history timeline. Every read here is ADMIN (`getPackHistory`,
 * `admin_users`) or MAIN read-only (`getPackMetaByIds`, `getHistoryCardMeta`) —
 * no MAIN write. Returns `null` for the "no snapshots" case so the caller can
 * render the empty state; throws only on a genuine read failure, which the
 * caller catches via `safeQueryOrNull` and degrades to a band.
 */
async function loadHistory(
  packId: string | undefined,
): Promise<HistoryData | null> {
  // Always read the unfiltered head so the pack picker stays populated with
  // every pack that has history (the picker must not collapse to a single pack
  // just because the timeline is currently scoped). The scoped timeline then
  // reads only the selected pack's snapshots.
  //
  // The two reads are independent, so they go out in ONE wave — filtering by
  // pack used to cost two serial ADMIN round-trips before first paint.
  const [allSnapshots, scoped] = await Promise.all([
    getPackHistory(undefined, TIMELINE_LIMIT),
    packId ? getPackHistory(packId, TIMELINE_LIMIT) : Promise.resolve(null),
  ]);
  const snapshots = scoped ?? allSnapshots;

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
    // No snapshots for this scope — the caller renders the empty state.
    return null;
  }

  // Batched ADMIN read: resolve every captured_by id → display name/email so the
  // timeline shows WHO captured each row instead of a raw UUID slug. Same
  // pattern as src/lib/queries/changelog.ts:106 / src/lib/balance-limits.ts:146.
  const capturedByIds = Array.from(
    new Set(snapshots.map((s) => s.capturedBy)),
  );
  const adminMap = new Map<
    string,
    { username: string; displayUsername: string | null; email: string }
  >();
  if (capturedByIds.length > 0) {
    const admins = await adminDb.admin_users.findMany({
      where: { id: { in: capturedByIds } },
      select: {
        id: true,
        username: true,
        display_username: true,
        email: true,
      },
    });
    for (const a of admins) {
      adminMap.set(a.id, {
        username: a.username,
        displayUsername: a.display_username,
        email: a.email,
      });
    }
  }

  // Batched MAIN read: card identity for the union of every card_id across all
  // visible snapshots. One PK probe (`id = ANY(...)`) — same shape as the
  // doctor's batch read (retune-actions.ts:847) — so the expand drawer renders
  // per-card name + image + value without N+1 lookups per row.
  const cardIds = Array.from(
    new Set(snapshots.flatMap((s) => s.cards.map((c) => c.card_id))),
  );
  const cardMeta = await getHistoryCardMeta(cardIds);

  const rows: HistoryRow[] = snapshots.map((s) => {
    const m = meta.get(s.packId);
    const admin = adminMap.get(s.capturedBy);
    // Per-card rows for the expand drawer — already shape-resolved server-side.
    const cards: HistoryCardRow[] = s.cards.map((c) => {
      const cm = cardMeta.get(c.card_id);
      return {
        cardId: c.card_id,
        name: cm?.name ?? null,
        imageUrl: cm?.imageUrl ?? null,
        value: cm?.value ?? 0,
        weight: c.weight,
      };
    });
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
      capturedByLabel:
        admin?.displayUsername ||
        admin?.username ||
        admin?.email ||
        null,
      price: s.price,
      cardCount: s.cards.length,
      cards,
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

  return { packOptions, rows };
}

/**
 * Streamed timeline. Wraps `loadHistory` in `safeQueryOrNull` so a transient
 * ADMIN/MAIN read fault degrades to an inline empty/error state instead of
 * throwing the whole route into its error boundary. `null` data with no error =
 * genuinely no snapshots; an error = a read failed (both render an empty-state,
 * with the error copy nudging a retry).
 */
async function HistoryStream({ packId }: { packId: string | undefined }) {
  const { data, error } = await safeQueryOrNull(
    () => loadHistory(packId),
    "pack-studio.history",
  );

  if (error) {
    return (
      <div className="rounded-md border">
        <EmptyState
          icon={History}
          title="Couldn't load change history"
          description="A read failed while building the timeline. It was logged — refresh to retry."
        />
      </div>
    );
  }

  if (!data) {
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

  return (
    <FadeIn>
      <HistoryPackFilter options={data.packOptions} />
      <HistoryTimeline rows={data.rows} />
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
