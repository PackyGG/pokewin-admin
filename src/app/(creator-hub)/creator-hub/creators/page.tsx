import { Suspense } from "react";
import { Users, TrendingUp } from "lucide-react";

import { requireRole } from "@/lib/dal";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { Skeleton } from "@/components/ui/skeleton";
import { DASHBOARD_PERIOD_LABELS } from "@/lib/queries/dashboard-period";

// Reuse the EXISTING add-creator dialog from the (admin) group 1:1 (plan:
// "reuse the existing add-creator server action/dialog"). It searches users +
// promotes to creator via the backend, gated on `/creators` access — which
// admins (the only viewers of the Hub today) hold.
import { AddCreatorDialog } from "../../../(admin)/creators/_components/add-creator-dialog";

import { parseRosterSearchParams } from "./_lib/roster-params";
import { listRosterCreators } from "./_queries/list-roster-creators";
import { RosterSearchProvider } from "./_components/roster-search-context";
import { RosterViewProvider } from "./_components/roster-view-context";
import { RosterToolbar } from "./_components/roster-toolbar";
import { RosterPeriodControl } from "./_components/roster-period-control";
import { RosterGrid } from "./_components/roster-grid";
import { RosterError } from "./_components/roster-error";

export const metadata = { title: "Creators · Creator Hub" };

/**
 * Creator Hub — Creators roster.
 *
 * A searchable, sortable card+table roster of every creator, reusing the
 * existing /creators data layer (backend roster walk + code/wager + windowed
 * cohort GGR + lifetime PnL + composed deal value). Rows link into the Hub's
 * own creator detail page (`/creator-hub/creators/[id]`).
 *
 * ACCESS: admin + creator_manager only (the Hub layout enforces it; this page
 * adds the explicit DAL gate too — every protected page gates server-side
 * first per the house convention).
 *
 * ACTIVE-TIMEFRAME-ONLY: the roster data block is wrapped in a Suspense
 * boundary keyed on `(sortBy, period)`, so only the active window + sort is
 * fetched on first render and switching lazily loads just the picked
 * combination. The instant search (`?q=`) is a pure client-side filter over
 * the already-fetched rows, so it is DELIBERATELY excluded from the Suspense
 * key — a keystroke never refetches the roster.
 */
export default async function CreatorHubRosterPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireRole(["admin", "creator_manager"]);

  const params = parseRosterSearchParams(await searchParams);
  // The canonical label already carries "Last …" (e.g. "Last 7 days"), so it
  // reads naturally inline without an extra "last" prefix.
  const windowLabel = DASHBOARD_PERIOD_LABELS[params.period];

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Users}
          accent="pink"
          title="Creators"
          subtitle="Your full creator roster — search, rank, and drill in."
          action={<AddCreatorDialog />}
        />
      </PageHero>

      <div className="space-y-3">
        <SectionHeading
          icon={TrendingUp}
          title="Roster"
          action={<RosterPeriodControl current={params.period} />}
        />
        {/* Search + view are pure client presentation over the SAME fetched
            rows, so both providers wrap the toolbar AND the grid (one shared
            state) and the Suspense key below omits `q`/`view`. */}
        <RosterSearchProvider>
          <RosterViewProvider>
            <div className="space-y-4">
              <RosterToolbar />
              <Suspense
                key={`${params.sortBy}-${params.period}`}
                fallback={<RosterSkeleton />}
              >
                <RosterSection
                  sortBy={params.sortBy}
                  period={params.period}
                  windowLabel={windowLabel}
                />
              </Suspense>
            </div>
          </RosterViewProvider>
        </RosterSearchProvider>
      </div>
    </div>
  );
}

// ─── Roster section (data-bearing, streamed via Suspense) ───────────

async function RosterSection({
  sortBy,
  period,
  windowLabel,
}: {
  sortBy: ReturnType<typeof parseRosterSearchParams>["sortBy"];
  period: ReturnType<typeof parseRosterSearchParams>["period"];
  windowLabel: string;
}) {
  const { creators, rosterUnavailable } = await listRosterCreators(
    period,
    sortBy,
  );

  if (rosterUnavailable) {
    return <RosterError />;
  }

  return (
    <FadeIn className="space-y-2">
      <p className="text-[11px] text-muted-foreground">
        Wager + GGR scoped to {windowLabel}. Sign-ups, FTDs, PnL, and deal
        value are lifetime.
      </p>
      <RosterGrid creators={creators} />
    </FadeIn>
  );
}

// ─── Skeleton ──────────────────────────────────────────────────────

function RosterSkeleton() {
  return (
    <div className="space-y-2">
      <Skeleton className="h-3 w-28" />
      <div className="grid grid-cols-1 gap-3 sm:gap-4 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-56 rounded-2xl" />
        ))}
      </div>
    </div>
  );
}
