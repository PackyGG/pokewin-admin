import { Suspense } from "react";
import { getLevelUpRewards } from "@/lib/queries/rewards";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import {
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { CreateRewardButton } from "./create-reward-button";
import { LevelUpTable } from "./level-up/level-up-table";
import { SectionHeading } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { TrendingUp } from "lucide-react";

/**
 * Level Up tab of the merged /rewards page (was /rewards/level-up).
 * Server-side paginated on `?page=`/`?perPage=` (shared list params, only
 * read when this tab is active). No inner sub-switch, so no namespacing
 * needed beyond the top-level `?tab=`.
 */
export function LevelUpTab({
  params,
}: {
  params: Record<string, string | undefined>;
}) {
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;

  return (
    <div className="space-y-4">
      <SectionHeading
        icon={TrendingUp}
        title="Level Up Rewards"
        action={<CreateRewardButton />}
      />
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
  );
}

async function LevelUpContent({
  page,
  perPage,
}: {
  page: number;
  perPage: number;
}) {
  // Wrapped in safeQuery so a slow/failed paginated read degrades to a calm
  // fallback tile instead of tearing down the whole /rewards route via the
  // segment error boundary; the shell (rendered outside this Suspense) stays.
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
