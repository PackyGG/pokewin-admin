import { Suspense } from "react";
import { TrendingUp } from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { getLevelUpRewards } from "@/lib/queries/rewards";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import {
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { CreateRewardButton } from "../create-reward-button";
import { LevelUpTable } from "./level-up-table";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";

export const metadata = { title: "Level Up" };

async function LevelUpContent({
  page,
  perPage,
}: {
  page: number;
  perPage: number;
}) {
  // Wrapped in safeQuery so a slow/failed paginated read degrades to a calm
  // fallback tile instead of tearing down the whole /rewards route via the
  // segment error boundary; PageHero (rendered outside this Suspense) stays.
  const EMPTY: Awaited<ReturnType<typeof getLevelUpRewards>> = {
    data: [],
    total: 0,
    page,
    perPage,
    totalPages: 0,
  };
  const { data: rewards, error } = await safeQuery(
    () => getLevelUpRewards({ page, perPage }),
    EMPTY,
    "rewards.level-up",
    REWARD_QUERY_TIMEOUT_MS,
  );

  if (error) {
    return (
      <TileErrorFallback
        label="Level-up rewards"
        hint="The read failed or timed out — no data was changed. Refresh to retry."
        size="panel"
      />
    );
  }

  return (
    <>
      <FadeIn>
        <LevelUpTable data={rewards.data} />
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

export default async function LevelUpPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/rewards/level-up");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={TrendingUp}
          title="Level Up Rewards"
          subtitle="Rewards users unlock when they reach specific levels."
          action={<CreateRewardButton />}
        />
      </PageHero>

      <div className="space-y-4">
        <Suspense
          key={`${page}|${perPage}`}
          fallback={
            <>
              <TableSkeleton rows={10} columns={7} />
              <PaginationSkeleton />
            </>
          }
        >
          <LevelUpContent page={page} perPage={perPage} />
        </Suspense>
      </div>
    </div>
  );
}
