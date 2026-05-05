import { Suspense } from "react";
import { TrendingUp } from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { getLevelUpRewards } from "@/lib/queries/rewards";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import {
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";
import { CreateRewardButton } from "../create-reward-button";
import { LevelUpTable } from "./level-up-table";
import { PageHero } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";

export const metadata = { title: "Level Up" };

async function LevelUpContent({
  page,
  perPage,
}: {
  page: number;
  perPage: number;
}) {
  const rewards = await getLevelUpRewards({ page, perPage });

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
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
              <TrendingUp className="size-5 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold leading-tight">Level Up Rewards</h1>
              <p className="text-sm text-muted-foreground">
                Rewards users unlock when they reach specific levels.
              </p>
            </div>
          </div>
          <CreateRewardButton />
        </div>
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
