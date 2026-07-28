import { Suspense } from "react";
import { Coins, UserX, Zap } from "lucide-react";

import { requireCreatorHubPageAccess } from "@/lib/require-creator-hub-access";
import { SectionHeading } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
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
import { RosterListSkeleton } from "./_components/roster-skeletons";

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

  const rosterIcon = isPast ? UserX : isMultiplier ? Zap : Coins;
  const rosterTitle = isPast
    ? "Past Creators"
    : isMultiplier
      ? "Multiplier Creators"
      : "Fill Creators";

  // Short window tag for the (only) window-scoped sort's label — every other
  // sort is lifetime. Past tab wager is always lifetime.
  const sortWindow = isPast
    ? "lifetime"
    : params.period === "all"
      ? "all-time"
      : params.period;

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <SectionHeading icon={rosterIcon} title={rosterTitle} />
        <RosterSearchProvider>
          <RosterViewProvider>
            <div className="space-y-4">
              <RosterToolbar
                tabs={<RosterTabSwitch />}
                period={
                  isPast ? null : (
                    <RosterPeriodControl current={params.period} />
                  )
                }
                sortWindow={sortWindow}
              />
              <Suspense
                key={
                  isPast
                    ? `past-${params.sortBy}`
                    : `${params.tab}-${params.sortBy}-${params.period}`
                }
                fallback={<RosterListSkeleton />}
              >
                <RosterSection
                  tab={params.tab}
                  sortBy={params.sortBy}
                  period={params.period}
                  view={params.view}
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
  view,
}: {
  tab: ReturnType<typeof parseRosterSearchParams>["tab"];
  sortBy: ReturnType<typeof parseRosterSearchParams>["sortBy"];
  period: ReturnType<typeof parseRosterSearchParams>["period"];
  view: ReturnType<typeof parseRosterSearchParams>["view"];
}) {
  const isPast = tab === "past";
  const { creators, rosterUnavailable } = isPast
    ? await listRosterExCreators(sortBy)
    : await listRosterCreators(period, sortBy, tab);

  if (rosterUnavailable) {
    return <RosterError />;
  }

  // Merged into the grid's single meta line ("N creators · {caption}").
  const windowLabel = DASHBOARD_PERIOD_LABELS[period];
  const caption = isPast
    ? "Lifetime wager, sign-ups, FTDs, and PnL for ex-creators. Windowed GGR is unavailable once the creator role is removed."
    : `Wager + GGR scoped to ${windowLabel}. Sign-ups, FTDs, PnL, and deal value are lifetime.`;

  // Server cards exist only when the grid actually renders — list view skips
  // the build. (A client-side list → grid flip re-requests the RSC payload;
  // the grid shows skeleton cards for that brief gap.)
  const wagerLabel = isPast ? "Lifetime wager" : "Wager";
  const cardsById =
    view === "grid"
      ? Object.fromEntries(
          creators.map((c) => [
            c.id,
            <RosterCard key={c.id} creator={c} wagerLabel={wagerLabel} />,
          ]),
        )
      : {};

  return (
    <FadeIn>
      <RosterGrid
        creators={creators}
        cardsById={cardsById}
        isPast={isPast}
        caption={caption}
      />
    </FadeIn>
  );
}
