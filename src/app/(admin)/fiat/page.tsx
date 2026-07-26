import { Suspense } from "react";
import { Wallet } from "lucide-react";

import {
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { requirePageAccess, sessionIsAdmin, sessionIsOwner } from "@/lib/dal";
import {
  FiatAccessTab,
  FiatConfigurationTab,
  FiatOverviewTab,
  FiatPaymentsTab,
  FiatWebhooksTab,
} from "./_components/fiat-tabs";
import { FiatTabNav } from "./_components/fiat-tab-nav";
import { parseFiatTab } from "./tabs";

export const metadata = { title: "Fiat" };

export default async function FiatPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await requirePageAccess("/fiat");
  const params = await searchParams;
  const tab = parseFiatTab(params.tab);
  const page = Math.max(1, Number(params.page) || 1);
  const perPage = Math.min(100, Math.max(10, Number(params.perPage) || 20));

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Wallet}
          accent="emerald"
          title="Fiat"
          subtitle="Whop deposits, limits, holds, access controls, and webhook health."
        />
      </PageHero>
      <FiatTabNav current={tab} />
      <Suspense
        key={`${tab}-${page}-${perPage}-${params.search ?? ""}-${params.status ?? ""}`}
        fallback={
          <div className="space-y-6">
            <KpiStripSkeleton count={4} />
            <SectionHeadingSkeleton titleWidth={150} />
            <TableSkeleton rows={8} columns={6} />
          </div>
        }
      >
        {tab === "configuration" ? (
          <FiatConfigurationTab
            canEdit={sessionIsAdmin(session) || sessionIsOwner(session)}
          />
        ) : tab === "payments" ? (
          <FiatPaymentsTab
            page={page}
            perPage={perPage}
            search={params.search}
            status={params.status}
          />
        ) : tab === "access" ? (
          <FiatAccessTab />
        ) : tab === "webhooks" ? (
          <FiatWebhooksTab />
        ) : (
          <FiatOverviewTab />
        )}
      </Suspense>
    </div>
  );
}
