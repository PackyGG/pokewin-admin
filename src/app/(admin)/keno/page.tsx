import { Suspense } from "react";
import { Dices } from "lucide-react";

import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import {
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";
import {
  requirePageAccess,
  sessionIsAdmin,
  sessionIsOwner,
} from "@/lib/dal";
import { parseKenoTab } from "./tabs";
import { KenoTabNav } from "./_components/keno-tab-nav";
import { KenoOverviewTab } from "./_components/overview-tab";
import { KenoConfigurationTab } from "./_components/configuration-tab";
import { KenoOddsTab } from "./_components/odds-tab";

export const metadata = { title: "Keno" };

export default async function KenoPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await requirePageAccess("/keno");
  const tab = parseKenoTab((await searchParams).tab);

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Dices}
          accent="purple"
          title="Keno"
          subtitle="Performance, controls, payout observations, and exact draw probabilities."
        />
      </PageHero>

      <KenoTabNav />

      <Suspense
        key={tab}
        fallback={
          <div className="space-y-6">
            <KpiStripSkeleton count={6} />
            <div className="space-y-3">
              <SectionHeadingSkeleton titleWidth={150} />
              <TableSkeleton rows={8} columns={6} />
            </div>
          </div>
        }
      >
        {tab === "configuration" ? (
          <KenoConfigurationTab
            canEdit={sessionIsAdmin(session) || sessionIsOwner(session)}
          />
        ) : tab === "odds" ? (
          <KenoOddsTab />
        ) : (
          <KenoOverviewTab />
        )}
      </Suspense>
    </div>
  );
}
