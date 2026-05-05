import { Suspense } from "react";
import Link from "next/link";
import { Percent } from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { getRakebackConfigs, getRakebackClaims } from "@/lib/queries/rewards";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import {
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";
import { cn } from "@/lib/utils";
import { RakebackConfigTable } from "./rakeback-config-table";
import { RakebackClaimsTable } from "./rakeback-claims-table";
import { PageHero } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";

export const metadata = { title: "Rakeback" };

const TABS = [
  { value: "claims", label: "Claims" },
  { value: "config", label: "Config" },
];

export default async function RakebackPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/rewards/rakeback");
  const params = await searchParams;
  const tab = params.tab || "claims";
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
            <Percent className="size-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold leading-tight">Rakeback</h1>
            <p className="text-sm text-muted-foreground">
              Configure rakeback percentages and track every claim.
            </p>
          </div>
        </div>
      </PageHero>

      <div className="space-y-4">
        <div className="flex gap-1 rounded-lg bg-muted p-1">
          {TABS.map((t) => (
            <Link
              key={t.value}
              href={`/rewards/rakeback?tab=${t.value}`}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                tab === t.value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {t.label}
            </Link>
          ))}
        </div>

        {tab === "config" && (
          <Suspense
            fallback={
              <div className="rounded-md border p-4">
                <TableSkeleton rows={6} columns={4} />
              </div>
            }
          >
            <ConfigTab />
          </Suspense>
        )}
        {tab === "claims" && (
          <Suspense
            key={`${page}|${perPage}|${params.type ?? ""}|${params.search ?? ""}`}
            fallback={
              <>
                <div className="flex gap-1 rounded-lg bg-muted p-1">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="h-7 w-20 rounded-md bg-muted-foreground/10 animate-pulse" />
                  ))}
                </div>
                <TableSkeleton rows={12} columns={6} />
                <PaginationSkeleton />
              </>
            }
          >
            <ClaimsTab page={page} perPage={perPage} type={params.type} search={params.search} />
          </Suspense>
        )}
      </div>
    </div>
  );
}

async function ConfigTab() {
  const configs = await getRakebackConfigs();
  return (
    <FadeIn>
      <RakebackConfigTable configs={configs} />
    </FadeIn>
  );
}

async function ClaimsTab({ page, perPage, type, search }: { page: number; perPage: number; type?: string; search?: string }) {
  const claims = await getRakebackClaims({ page, perPage, type, search });

  return (
    <>
      <div className="flex gap-1 rounded-lg bg-muted p-1">
        {["all", "daily", "weekly", "monthly"].map((t) => (
          <Link
            key={t}
            href={`/rewards/rakeback?tab=claims&type=${t}`}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors capitalize",
              (type || "all") === t
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {t}
          </Link>
        ))}
      </div>
      <FadeIn>
        <RakebackClaimsTable data={claims.data} />
      </FadeIn>
      <DataTablePagination
        page={claims.page}
        totalPages={claims.totalPages}
        total={claims.total}
        perPage={claims.perPage}
      />
    </>
  );
}
