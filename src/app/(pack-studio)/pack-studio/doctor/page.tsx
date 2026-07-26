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
  getPackRiskRowsResult,
  type PackRiskFilters,
  type PackRiskSortKey,
} from "../_queries/doctor";
import { readEdgeCurveConfig } from "@/app/(admin)/packs/_lib/risk-config";
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
// route headroom — matching the transaction timeout in
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
  const { rows, error } = await getPackRiskRowsResult(filters);

  // A FAILED read also yields zero rows, so it must be separated from a
  // genuinely empty snapshot BEFORE the empty state below — otherwise an
  // outage tells the operator to run a snapshot that already exists, and
  // "Snapshot now" is the one action that cannot help. The reason string is
  // not echoed (it is the raw driver message); it is logged server-side.
  if (error) {
    return (
      <div className="rounded-md border border-rose-500/40 bg-rose-500/5">
        <EmptyState
          icon={Stethoscope}
          title="Couldn't load the risk snapshot"
          description="The read failed — this is not an empty snapshot. Reload to retry; if it persists, check the Pack Studio logs."
        />
      </div>
    );
  }

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
 * Owner-only "raise price to the edge floor" hero action. Reads from the SAME
 * persisted snapshot the grid renders (no MAIN write), so the candidate set
 * always matches what the operator sees. Streamed behind its own boundary so it
 * never blocks the hero's first paint.
 *
 * CANDIDATES ARE PACKS UNDER THE FLOOR, NOT "below target" (fixed 2026-07-23).
 * The grid's `belowTarget` flag is judged against each pack's PER-PACK curve
 * target — floor + a risk premium, up to 11.50% — so a pack sitting at 11.0%
 * against an 11.1% curve target counts as below-target while being perfectly
 * fine by this action's rule. Feeding those in made the button's count stick at
 * the below-target number no matter how many packs the run had already lifted
 * over 10.99%, and padded the plan with packs it could only report as
 * "unchanged". The count now means what it says: packs earning under 10.99%.
 */
async function RepinAction() {
  const [rows, edgeCurve] = await Promise.all([
    getPackRiskRows(),
    readEdgeCurveConfig(),
  ]);
  const candidateIds = rows
    .filter((r) => r.edge < edgeCurve.edgeFloor)
    .map((r) => r.packId);
  return <RepinCustomButton candidateIds={candidateIds} />;
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

  // Suspense key includes every FILTER dimension so changing one re-suspends
  // the grid (showing the skeleton) instead of holding rows from the old
  // filter during the re-read.
  //
  // SORT IS DELIBERATELY NOT IN THE KEY. A sort change returns the SAME row
  // set in a different order, so remounting bought nothing — and it cost the
  // operator real work: `DoctorTable` keeps its bulk-retune selection in
  // client state, and a key change unmounts the subtree and throws that away.
  // Selecting a dozen packs and then sorting to check one of them silently
  // cleared the selection. Reusing the key lets React reconcile instead:
  // selection survives, and there is no skeleton flash for a pure reorder.
  // Safe for the filter path too — the table already prunes selected ids that
  // are no longer in the row set.
  const suspenseKey = [
    filters.tier ?? "",
    filters.belowTarget ? "1" : "0",
    filters.overCap ? "1" : "0",
    filters.zeroNearMiss ? "1" : "0",
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
