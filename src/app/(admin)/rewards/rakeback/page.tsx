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
import { InstantClaimSection } from "./instant-claim-section";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { LinkPending } from "@/components/ux";
import { safeQuery } from "@/lib/errors/safe-query";
import {
  getRakebackInstantClaimConfig,
  getRakebackInstantClaimUsage,
  isInstantClaimPeriod,
  type InstantClaimPeriod,
} from "@/lib/queries/rakeback-instant-claim";

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
  const icPeriod: InstantClaimPeriod = isInstantClaimPeriod(params.icPeriod)
    ? params.icPeriod
    : "30d";

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Percent}
          title="Rakeback"
          subtitle="Configure rakeback percentages and track every claim."
        />
      </PageHero>

      <div className="space-y-4">
        <div className="flex gap-1 rounded-lg bg-muted p-1">
          {TABS.map((t) => (
            <Link
              key={t.value}
              href={`/rewards/rakeback?tab=${t.value}`}
              className={cn(
                "inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                tab === t.value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {t.label}
              <LinkPending size={13} />
            </Link>
          ))}
        </div>

        {tab === "config" && (
          <div className="space-y-8">
            <Suspense
              key={`ic-${icPeriod}`}
              fallback={
                <div className="rounded-xl border p-4">
                  <TableSkeleton rows={4} columns={2} />
                </div>
              }
            >
              <InstantClaimTab period={icPeriod} />
            </Suspense>
            <Suspense
              fallback={
                <div className="rounded-md border p-4">
                  <TableSkeleton rows={6} columns={4} />
                </div>
              }
            >
              <ConfigTab />
            </Suspense>
          </div>
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

async function InstantClaimTab({ period }: { period: InstantClaimPeriod }) {
  // Active-timeframe-only: only the selected window is queried. Both reads
  // degrade gracefully (drift-safe: the early-claim columns exist on dev but
  // not prod — the query probes and returns `supported: false` there).
  const [{ data: config }, { data: usage }] = await Promise.all([
    safeQuery(
      () => getRakebackInstantClaimConfig(),
      { supported: false as const },
      "rakeback.instant-claim.config",
      15_000,
    ),
    safeQuery(
      () => getRakebackInstantClaimUsage(period),
      { supported: false as const },
      "rakeback.instant-claim.usage",
      15_000,
    ),
  ]);

  return (
    <FadeIn>
      <InstantClaimSection config={config} usage={usage} period={period} />
    </FadeIn>
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
              "inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium transition-colors capitalize",
              (type || "all") === t
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {t}
            <LinkPending size={13} />
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
