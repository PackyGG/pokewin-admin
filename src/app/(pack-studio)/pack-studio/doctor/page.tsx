import { Suspense } from "react";
import { Stethoscope } from "lucide-react";

import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { EmptyState } from "@/components/empty-state";
import { TableSkeleton } from "@/components/loading-skeletons";
import { FadeIn } from "@/components/fade-in";
import { requirePackStudioPageAccess } from "@/lib/require-pack-studio-access";
import { isPackStudioRetuneOperator } from "@/lib/reprice-access";
import {
  getPackRiskRows,
  type PackRiskFilters,
  type PackRiskSortKey,
} from "../_queries/doctor";
import { SnapshotButton } from "./snapshot-button";
import { DoctorFilters } from "./doctor-filters";
import { DoctorTable } from "./doctor-table";
import { RepinCustomButton } from "./repin-custom-button";

/**
 * Pack Studio — Pack Doctor. Scored grid of every active cash pack's persisted
 * risk profile (`pack_risk_scores`, ADMIN DB) joined to live pack identity
 * (MAIN, read-only) — PLUS the operator write tools that grew on top of the
 * grid: "Snapshot now" (re-scores the fleet, ADMIN-DB upsert), the owner-only
 * "Re-pin below-target packs" hero action, and the per-row re-tune drawer /
 * bulk re-tune in `DoctorTable` (TOTP-gated MAIN writes via the retune
 * actions). The GRID RENDER itself stays read-only; every write goes through
 * its own confirm + TOTP + audit path.
 *
 * Shell-first: the hero + actions + filter bar paint immediately while the
 * grid streams behind a `<Suspense>` boundary keyed on the active filter set
 * (see `loading.tsx` for the matching skeleton).
 */

// The "Snapshot now" server action (POST handled by this route's function)
// scores every active cash pack and upserts one ADMIN-DB row per pack inside a
// single interactive transaction. Against the remote ADMIN DB on Vercel that
// batch can run well past the platform's default function budget, so give the
// route headroom — matching the raised Prisma transaction timeout in
// `../_actions/snapshot.ts`. (The read render itself is fast and cached.)
export const maxDuration = 120;

const VALID_SORT_KEYS: ReadonlySet<PackRiskSortKey> = new Set<PackRiskSortKey>([
  "name",
  "price",
  "edge",
  "cv",
  "winRate",
  "nearMiss",
  "maxWin",
  "maxMult",
  "riskScore",
  "tier",
]);

type SearchParams = Record<string, string | string[] | undefined>;

function readOne(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Map the page querystring to the {@link PackRiskFilters} the doctor query
 * consumes. `sortBy`/`sortOrder` (written by the shared `DataTableColumnHeader`)
 * map to the query's `sortBy`/`sortDir`; an unrecognized sort key falls through
 * to the query's own default (riskScore desc).
 */
function paramsToFilters(sp: SearchParams): PackRiskFilters {
  const tier = readOne(sp.tier);
  const rawSortBy = readOne(sp.sortBy);
  const sortBy =
    rawSortBy && VALID_SORT_KEYS.has(rawSortBy as PackRiskSortKey)
      ? (rawSortBy as PackRiskSortKey)
      : undefined;
  const sortDir = readOne(sp.sortOrder) === "asc" ? "asc" : "desc";

  return {
    tier: tier === "T1" || tier === "T2" || tier === "T3" || tier === "T4" || tier === "T5"
      ? tier
      : undefined,
    belowTarget: readOne(sp.belowTarget) === "1",
    overCap: readOne(sp.overCap) === "1",
    zeroNearMiss: readOne(sp.zeroNearMiss) === "1",
    sortBy,
    sortDir,
  };
}

/** Are any filters (not sort) active? Drives the no-snapshot vs no-match copy. */
function hasActiveFilters(f: PackRiskFilters): boolean {
  return Boolean(f.tier || f.belowTarget || f.overCap || f.zeroNearMiss);
}

async function DoctorGrid({
  filters,
  owner,
}: {
  filters: PackRiskFilters;
  owner: boolean;
}) {
  const rows = await getPackRiskRows(filters);

  // No rows AND no filters applied → there is no snapshot yet (or no in-scope
  // packs). Prompt the operator to run one. With filters applied, defer to the
  // table's own "no match" empty state so the filter bar stays usable.
  if (rows.length === 0 && !hasActiveFilters(filters)) {
    return (
      <div className="rounded-md border">
        <EmptyState
          icon={Stethoscope}
          title="No snapshot yet"
          description='Run "Snapshot now" to score every active cash pack and populate the grid.'
        />
      </div>
    );
  }

  return (
    <FadeIn>
      <DoctorTable rows={rows} isOwner={owner} />
    </FadeIn>
  );
}

/**
 * Owner-only "Re-pin below-target packs" hero actions. Reads the below-target
 * packs from the SAME persisted snapshot the grid renders (no MAIN write), so
 * the candidate set always matches what the operator sees. Streamed behind its
 * own boundary so it never blocks the hero's first paint.
 *
 * Two buttons over ONE candidate set — the read happens once and both flavours
 * share it. Below-target is a superset of below-FLOOR (a pack's curve target is
 * never under the floor), so the raise-only run sees every pack under 10.99%;
 * the ones already at or above it drop out of its plan as skipped.
 */
async function RepinAction() {
  const below = await getPackRiskRows({ belowTarget: true });
  const candidateIds = below.map((r) => r.packId);
  return (
    <>
      <RepinCustomButton candidateIds={candidateIds} />
      <RepinCustomButton
        candidateIds={candidateIds}
        mode="floor-raise-only"
        variant="outline"
      />
    </>
  );
}

export default async function PackDoctorPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await requirePackStudioPageAccess();
  // The local `owner` flag controls visibility of the per-row Re-tune action +
  // the hero "Re-pin below-target packs" button. We grant it to owners AND to
  // the hard-coded Pack-Studio retune operator allowlist so an operator (e.g.
  // `demee`) sees the same controls — the server-side write actions enforce
  // the same predicate, so hiding-or-showing the button isn't security on its
  // own; this just keeps the UI consistent with what the server accepts.
  const owner = isPackStudioRetuneOperator(session);

  const sp = await searchParams;
  const filters = paramsToFilters(sp);

  // Suspense key includes every filter + sort dimension so switching any of
  // them re-suspends the grid (showing the skeleton) instead of holding stale
  // rows during the re-read.
  const suspenseKey = [
    filters.tier ?? "",
    filters.belowTarget ? "1" : "0",
    filters.overCap ? "1" : "0",
    filters.zeroNearMiss ? "1" : "0",
    filters.sortBy ?? "riskScore",
    filters.sortDir ?? "desc",
  ].join("|");

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Stethoscope}
          accent="purple"
          title="Pack Doctor"
          subtitle="Diagnose pack edge, EV, and risk health across every cash pack."
          action={
            <div className="flex flex-wrap items-center gap-2">
              {owner && (
                <Suspense fallback={null}>
                  <RepinAction />
                </Suspense>
              )}
              <SnapshotButton />
            </div>
          }
        />
      </PageHero>

      <div className="space-y-3">
        <SectionHeading
          icon={Stethoscope}
          title="Scored packs"
          action={<DoctorFilters />}
        />
        <Suspense
          key={suspenseKey}
          fallback={<TableSkeleton rows={8} columns={10} />}
        >
          <DoctorGrid filters={filters} owner={owner} />
        </Suspense>
      </div>
    </div>
  );
}
