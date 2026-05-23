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
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
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
        <PageHeroIdentity
          icon={Ticket}
          title="Raffles"
          subtitle="Active and historic raffles — entries, participants, and winners."
          action={<CreateRaffleButton />}
        />
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
