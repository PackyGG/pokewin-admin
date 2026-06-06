import { Suspense } from "react";
import { Users, TrendingUp, UserX } from "lucide-react";

import { requireCreatorHubPageAccess } from "@/lib/require-creator-hub-access";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { Skeleton } from "@/components/ui/skeleton";
import { DASHBOARD_PERIOD_LABELS } from "@/lib/queries/dashboard-period";

import { AddCreatorDialogV2 } from "./_components/add-creator-dialog-v2";

import { parseRosterSearchParams } from "./_lib/roster-params";
import { listRosterCreators } from "./_queries/list-roster-creators";
import { listRosterExCreators } from "./_queries/list-roster-ex-creators";
import { RosterSearchProvider } from "./_components/roster-search-context";
import { RosterSelectionProvider } from "./_components/roster-selection-context";
import { RosterViewProvider } from "./_components/roster-view-context";
import { RosterToolbar } from "./_components/roster-toolbar";
import { RosterPeriodControl } from "./_components/roster-period-control";
import { RosterTabSwitch } from "./_components/roster-tab-switch";
import { RosterGrid } from "./_components/roster-grid";
import { RosterCard } from "./_components/roster-card";
import { RosterError } from "./_components/roster-error";

export const metadata = { title: "Creators · Creator Hub" };

export default async function CreatorHubRosterPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requireCreatorHubPageAccess();

  const params = parseRosterSearchParams(await searchParams);
  const isPast = params.tab === "past";
  const windowLabel = DASHBOARD_PERIOD_LABELS[params.period];

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={isPast ? UserX : Users}
          accent="pink"
          title={isPast ? "Past Creators" : "Creators"}
          subtitle={
            isPast
              ? "Canceled / role-removed ex-creators — historical roster."
              : "Your full creator roster — search, rank, and drill in."
          }
          action={isPast ? undefined : <AddCreatorDialogV2 />}
        />
      </PageHero>

      <div className="space-y-3">
        <SectionHeading
          icon={TrendingUp}
          title="Roster"
          action={
            isPast ? (
              <RosterTabSwitch />
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <RosterTabSwitch />
                <RosterPeriodControl current={params.period} />
              </div>
            )
          }
        />
        <RosterSearchProvider>
          <RosterSelectionProvider>
            <RosterViewProvider>
              <div className="space-y-4">
                <RosterToolbar />
              <Suspense
                key={
                  isPast
                    ? `past-${params.sortBy}`
                    : `${params.sortBy}-${params.period}`
                }
                fallback={<RosterSkeleton />}
              >
                <RosterSection
                  tab={params.tab}
                  sortBy={params.sortBy}
                  period={params.period}
                  windowLabel={windowLabel}
                />
              </Suspense>
              </div>
            </RosterViewProvider>
          </RosterSelectionProvider>
        </RosterSearchProvider>
      </div>
    </div>
  );
}

async function RosterSection({
  tab,
  sortBy,
  period,
  windowLabel,
}: {
  tab: ReturnType<typeof parseRosterSearchParams>["tab"];
  sortBy: ReturnType<typeof parseRosterSearchParams>["sortBy"];
  period: ReturnType<typeof parseRosterSearchParams>["period"];
  windowLabel: string;
}) {
  const isPast = tab === "past";
  const { creators, rosterUnavailable } = isPast
    ? await listRosterExCreators(sortBy)
    : await listRosterCreators(period, sortBy);

  if (rosterUnavailable) {
    return <RosterError />;
  }

  const wagerLabel = isPast ? "Lifetime wager" : "Wager";
  const cardsById = Object.fromEntries(
    creators.map((c) => [
      c.id,
      <RosterCard key={c.id} creator={c} wagerLabel={wagerLabel} />,
    ]),
  );

  return (
    <FadeIn className="space-y-2">
      <p className="text-[11px] text-muted-foreground">
        {isPast ? (
          <>
            Lifetime wager, sign-ups, FTDs, and PnL for ex-creators. Windowed
            GGR is unavailable once the creator role is removed.
          </>
        ) : (
          <>
            Wager + GGR scoped to {windowLabel}. Sign-ups, FTDs, PnL, and deal
            value are lifetime.
          </>
        )}
      </p>
      <RosterGrid creators={creators} cardsById={cardsById} isPast={isPast} />
    </FadeIn>
  );
}

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
