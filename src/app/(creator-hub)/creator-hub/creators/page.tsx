import { Suspense } from "react";
import { Coins, TrendingUp, UserX, Zap } from "lucide-react";

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
  const isMultiplier = params.tab === "multiplier";
  const windowLabel = DASHBOARD_PERIOD_LABELS[params.period];

  const heroIcon = isPast ? UserX : isMultiplier ? Zap : Coins;
  const heroTitle = isPast
    ? "Past Creators"
    : isMultiplier
      ? "Multiplier Creators"
      : "Active Creators";
  const heroSubtitle = isPast
    ? "Canceled / role-removed ex-creators — historical roster."
    : isMultiplier
      ? "Multiplier-program creators with no fill deal — search, rank, and drill in."
      : "Fill-deal creators on active or scheduled deals — search, rank, and drill in.";

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={heroIcon}
          accent="pink"
          title={heroTitle}
          subtitle={heroSubtitle}
          action={isPast || isMultiplier ? undefined : <AddCreatorDialogV2 />}
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
              <div className="flex w-full min-w-0 flex-col items-stretch gap-2 sm:items-end lg:flex-row lg:flex-wrap lg:items-center">
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
                    : `${params.tab}-${params.sortBy}-${params.period}`
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
  const isMultiplier = tab === "multiplier";
  const { creators, rosterUnavailable } = isPast
    ? await listRosterExCreators(sortBy)
    : await listRosterCreators(
        period,
        sortBy,
        isMultiplier ? "multiplier" : "active",
      );

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
        ) : isMultiplier ? (
          <>
            Multiplier creators without a fill deal. Wager + GGR scoped to{" "}
            {windowLabel}. Sign-ups, FTDs, and PnL are lifetime.
          </>
        ) : (
          <>
            Fill-deal creators. Wager + GGR scoped to {windowLabel}. Sign-ups,
            FTDs, PnL, and deal value are lifetime.
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
