import { Suspense } from "react";
import { Coins, UserX, Zap } from "lucide-react";

import { requireCreatorHubPageAccess } from "@/lib/require-creator-hub-access";
import { SectionHeading } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { Skeleton } from "@/components/ui/skeleton";
import { DASHBOARD_PERIOD_LABELS } from "@/lib/queries/dashboard-period";

import { parseRosterSearchParams } from "./_lib/roster-params";
import { listRosterCreators } from "./_queries/list-roster-creators";
import { listRosterExCreators } from "./_queries/list-roster-ex-creators";
import { RosterSearchProvider } from "./_components/roster-search-context";
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

  // The page-top hero was dropped: `PageHeroIdentity` no longer renders a
  // title/subtitle (owner removed that chrome), so it was a full row spent on
  // one Add Creator button plus the stack gap above the roster. The button
  // moved into `RosterToolbar`'s existing controls row, and the tab identity
  // moved onto the section heading below — which actually renders.
  const rosterIcon = isPast ? UserX : isMultiplier ? Zap : Coins;
  const rosterTitle = isPast
    ? "Past Creators"
    : isMultiplier
      ? "Multiplier Creators"
      : "Fill Creators";

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <SectionHeading
          icon={rosterIcon}
          title={rosterTitle}
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
    : await listRosterCreators(period, sortBy, tab);

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
