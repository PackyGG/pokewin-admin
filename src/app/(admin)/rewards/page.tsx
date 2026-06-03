import { Suspense } from "react";
import Link from "next/link";
import { Gift } from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { getRakebackStats, getRewards } from "@/lib/queries/rewards";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import {
  TableSkeleton,
  PaginationSkeleton,
  StatPanelSkeleton,
} from "@/components/loading-skeletons";
import { cn } from "@/lib/utils";
import { RewardsOverview } from "./rewards-overview";
import { CreateRewardButton } from "./create-reward-button";
import { RewardsTable } from "./rewards-table";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { LinkPending } from "@/components/ux";

export const metadata = { title: "Rewards" };

async function RewardsOverviewAsync() {
  const stats = await getRakebackStats();
  return <RewardsOverview stats={stats} />;
}

async function RewardsTableAsync({
  page,
  perPage,
  type,
  search,
}: {
  page: number;
  perPage: number;
  type?: string;
  search?: string;
}) {
  const rewards = await getRewards({ page, perPage, type, search });

  return (
    <>
      <FadeIn>
        <RewardsTable data={rewards.data} />
      </FadeIn>
      <DataTablePagination
        page={rewards.page}
        totalPages={rewards.totalPages}
        total={rewards.total}
        perPage={rewards.perPage}
      />
    </>
  );
}

export default async function RewardsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/rewards");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;
  const type = params.type;
  const search = params.search;

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Gift}
          title="Rewards"
          subtitle="One-time, daily, and balance rewards — plus rakeback claim stats."
        />
      </PageHero>

      {/* Rakeback overview and the rewards table are independent — render
          each behind its own Suspense boundary so the table doesn't have
          to wait on the rakeback aggregate, and vice versa. */}
      <Suspense
        fallback={
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <StatPanelSkeleton key={i} rows={2} />
            ))}
          </div>
        }
      >
        <RewardsOverviewAsync />
      </Suspense>

      <div className="space-y-4">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex gap-1 rounded-lg bg-muted p-1">
            {["all", "one_time", "daily", "balance"].map((t) => (
              <Link
                key={t}
                href={`/rewards?type=${t}`}
                className={cn(
                  "inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  (type || "all") === t
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {t === "one_time" ? "One Time" : t === "all" ? "All" : t.charAt(0).toUpperCase() + t.slice(1)}
                <LinkPending size={13} />
              </Link>
            ))}
          </div>
          <CreateRewardButton />
        </div>
        <Suspense
          key={`${page}|${perPage}|${type ?? ""}|${search ?? ""}`}
          fallback={
            <>
              <TableSkeleton rows={10} columns={8} />
              <PaginationSkeleton />
            </>
          }
        >
          <RewardsTableAsync page={page} perPage={perPage} type={type} search={search} />
        </Suspense>
      </div>
    </div>
  );
}
