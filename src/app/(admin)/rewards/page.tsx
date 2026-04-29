import { Suspense } from "react";
import Link from "next/link";
import { Gift } from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { getRakebackStats, getRewards } from "@/lib/queries/rewards";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency, formatDateTime } from "@/lib/utils/format";
import {
  TableSkeleton,
  PaginationSkeleton,
  StatPanelSkeleton,
} from "@/components/loading-skeletons";
import { cn } from "@/lib/utils";
import { RewardsOverview } from "./rewards-overview";
import { CreateRewardButton } from "./create-reward-button";
import { EditRewardButton } from "./edit-reward-button";
import { DeleteRewardButton } from "./delete-reward-button";
import { PageHero } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";

export const metadata = { title: "Rewards" };

async function RewardsOverviewAsync() {
  const stats = await getRakebackStats();
  return <RewardsOverview stats={stats} />;
}

async function RewardsTable({
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
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Slug</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Level Required</TableHead>
                <TableHead>Cash Amount</TableHead>
                <TableHead>Packs</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="w-[80px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rewards.data.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">{r.name}</TableCell>
                  <TableCell className="text-muted-foreground">{r.slug}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="capitalize">{r.type.replace("_", " ")}</Badge>
                  </TableCell>
                  <TableCell>{r.levelRequired}</TableCell>
                  <TableCell>{r.cashAmount != null ? formatCurrency(r.cashAmount) : "—"}</TableCell>
                  <TableCell>
                    {r.packs.length > 0 ? (
                      <div className="flex flex-col gap-1">
                        {r.packs.map((p) => (
                          <div key={p.id} className="flex items-center gap-1.5">
                            {p.imageUrl && (
                              <img src={p.imageUrl} alt="" className="size-5 rounded object-contain" />
                            )}
                            <span className="text-xs">{p.name}</span>
                            <span className="text-xs text-muted-foreground">{formatCurrency(p.priceUsd)}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>{formatDateTime(r.createdAt)}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <EditRewardButton reward={r} />
                      <DeleteRewardButton rewardId={r.id} />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {rewards.data.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="h-24 text-center text-muted-foreground">No rewards found.</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
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
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
            <Gift className="size-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold leading-tight">Rewards</h1>
            <p className="text-sm text-muted-foreground">
              One-time, daily, and balance rewards — plus rakeback claim stats.
            </p>
          </div>
        </div>
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
                  "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  (type || "all") === t
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {t === "one_time" ? "One Time" : t === "all" ? "All" : t.charAt(0).toUpperCase() + t.slice(1)}
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
          <RewardsTable page={page} perPage={perPage} type={type} search={search} />
        </Suspense>
      </div>
    </div>
  );
}
