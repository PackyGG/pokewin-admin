import { Suspense } from "react";
import Link from "next/link";
import { Ticket } from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { getRaffles } from "@/lib/queries/raffles";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import {
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";
import { cn } from "@/lib/utils";
import { CreateRaffleButton } from "./create-raffle-button";
import { RafflesTable } from "./raffles-table";
import { PageHero } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";

export const metadata = { title: "Raffles" };

async function RafflesContent({
  page,
  perPage,
  status,
  search,
}: {
  page: number;
  perPage: number;
  status?: string;
  search?: string;
}) {
  const raffles = await getRaffles({ page, perPage, status, search });

  return (
    <>
      <FadeIn>
        <RafflesTable data={raffles.data} />
      </FadeIn>

      <DataTablePagination
        page={raffles.page}
        totalPages={raffles.totalPages}
        total={raffles.total}
        perPage={raffles.perPage}
      />
    </>
  );
}

export default async function RafflesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/rewards/raffles");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;

  const suspenseKey = `${page}|${perPage}|${params.status ?? ""}|${params.search ?? ""}`;

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
              <Ticket className="size-5 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold leading-tight">Raffles</h1>
              <p className="text-sm text-muted-foreground">
                Active and historic raffles — entries, participants, and winners.
              </p>
            </div>
          </div>
          <CreateRaffleButton />
        </div>
      </PageHero>

      <div className="space-y-4">
        <div className="flex gap-1 rounded-lg bg-muted p-1">
          {["all", "active", "completed", "cancelled"].map((s) => (
            <Link
              key={s}
              href={`/rewards/raffles?status=${s}${params.search ? `&search=${params.search}` : ""}`}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors capitalize",
                (params.status || "all") === s
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {s}
            </Link>
          ))}
        </div>

        <Suspense
          key={suspenseKey}
          fallback={
            <>
              <TableSkeleton rows={12} columns={8} />
              <PaginationSkeleton />
            </>
          }
        >
          <RafflesContent
            page={page}
            perPage={perPage}
            status={params.status}
            search={params.search}
          />
        </Suspense>
      </div>
    </div>
  );
}
