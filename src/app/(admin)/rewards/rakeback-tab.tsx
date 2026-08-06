import { Suspense } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { getRakebackConfigs, getRakebackClaims } from "@/lib/queries/rewards";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import {
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";
import { cn } from "@/lib/utils";
import { RakebackConfigTable } from "./rakeback/rakeback-config-table";
import { RakebackClaimsTable } from "./rakeback/rakeback-claims-table";
import { InstantClaimSection } from "./rakeback/instant-claim-section";
import { InstantClaimSummaryBox } from "./rakeback/instant-claim-summary-box";
import { FadeIn } from "@/components/fade-in";
import { LinkPending } from "@/components/ux";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import { parsePagination } from "@/lib/utils/pagination";
import {
  getRakebackInstantClaimConfig,
  getRakebackInstantClaimUsage,
  isInstantClaimPeriod,
  type InstantClaimPeriod,
} from "@/lib/queries/rakeback-instant-claim";

/**
 * Rakeback tab of the merged /rewards page (was the standalone
 * /rewards/rakeback page). Its OWN Claims|Config inner switch is namespaced
 * to `?rbtab=` so it never collides with the top-level Rain|…|Leaderboards
 * switch (`?tab=`). Only the active inner sub-tab awaits its data.
 */
const RB_SUBTABS = [
  { value: "claims", label: "Claims" },
  { value: "config", label: "Config" },
];

/**
 * Inline "couldn't load" band — mirrors the amber notice the Challenges /
 * Leaderboards tabs render when their safeQuery-wrapped read fails, so a slow /
 * failing rakeback read degrades to a per-sub-tab notice instead of throwing to
 * the /rewards route error boundary (which blanks the WHOLE hub).
 */
function RakebackLoadErrorBand({ what }: { what: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3"
    >
      <AlertTriangle
        aria-hidden
        className="mt-0.5 size-4 shrink-0 text-amber-500"
      />
      <p className="text-xs text-amber-700 dark:text-amber-300">
        Couldn&apos;t load {what} — the query timed out or failed. This is a{" "}
        <span className="font-medium">request error, not zero results</span>.
        Refresh to retry.
      </p>
    </div>
  );
}

export function RakebackTab({
  params,
}: {
  params: Record<string, string | undefined>;
}) {
  const rbtab = params.rbtab || "claims";
  const { page, perPage } = parsePagination(params);
  const icPeriod: InstantClaimPeriod = isInstantClaimPeriod(params.icPeriod)
    ? params.icPeriod
    : "30d";

  return (
    <div className="space-y-4">
      <div className="flex gap-1 rounded-lg border bg-muted/50 p-1">
        {RB_SUBTABS.map((t) => (
          <Link
            key={t.value}
            href={`/rewards?tab=rakeback&rbtab=${t.value}`}
            className={cn(
              "inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              rbtab === t.value
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
            <LinkPending size={13} />
          </Link>
        ))}
      </div>

      {rbtab === "config" && (
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
      {rbtab === "claims" && (
        <>
          {/* Period-scoped boundary: the timeframe chips live inside the
              summary box, so switching `icPeriod` only re-suspends/refetches
              this heavy per-period aggregate — the claims table below has
              its own boundary and is never blocked behind it. */}
          <Suspense
            key={`ic-summary-${icPeriod}|${params.type ?? ""}`}
            fallback={
              <div className="h-28 rounded-xl border bg-muted/20 animate-pulse" />
            }
          >
            <ClaimsSummary icPeriod={icPeriod} type={params.type} />
          </Suspense>
          {/* Table boundary is period-independent (keyed only on
              page/perPage/type/search) so a timeframe switch never collapses
              the table into a skeleton. */}
          <Suspense
            key={`${page}|${perPage}|${params.type ?? ""}|${params.search ?? ""}`}
            fallback={
              <>
                <div className="flex gap-1 rounded-lg border bg-muted/50 p-1">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div
                      key={i}
                      className="h-7 w-20 rounded-md bg-muted-foreground/10 animate-pulse"
                    />
                  ))}
                </div>
                <TableSkeleton rows={12} columns={6} />
                <PaginationSkeleton />
              </>
            }
          >
            <ClaimsTable
              page={page}
              perPage={perPage}
              type={params.type}
              search={params.search}
              icPeriod={icPeriod}
            />
          </Suspense>
        </>
      )}
    </div>
  );
}

async function InstantClaimTab({ period }: { period: InstantClaimPeriod }) {
  // Active-timeframe-only: only the selected window is queried. Both reads
  // degrade gracefully (drift-safe: the early-claim columns are present on
  // prod — the feature is live — and the query probes `information_schema`
  // so an unmigrated env returns `supported: false` instead of throwing).
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
  // safeQuery so a slow / failing rakeback-config read degrades to an inline
  // band instead of throwing up the /rewards route boundary (which blanks the
  // WHOLE hub). Fallback is an empty config list.
  const { data: configs, error } = await safeQuery(
    () => getRakebackConfigs(),
    [] as Awaited<ReturnType<typeof getRakebackConfigs>>,
    "rakeback.configs",
    REWARD_QUERY_TIMEOUT_MS,
  );
  if (error !== null) {
    return <RakebackLoadErrorBand what="rakeback config" />;
  }
  return (
    <FadeIn>
      <RakebackConfigTable configs={configs} />
    </FadeIn>
  );
}

async function ClaimsSummary({
  icPeriod,
  type,
}: {
  icPeriod: InstantClaimPeriod;
  type?: string;
}) {
  // Active-timeframe-only: only the selected window is queried. Cached
  // per-period on prod + safeQuery 15s timeout (see rakeback-instant-claim.ts).
  const { data: usage } = await safeQuery(
    () => getRakebackInstantClaimUsage(icPeriod),
    { supported: false as const },
    "rakeback.instant-claim.claims-summary",
    15_000,
  );

  const typeFilter = type && type !== "all" ? type : undefined;

  return (
    <FadeIn>
      <InstantClaimSummaryBox
        usage={usage}
        period={icPeriod}
        claimType={typeFilter}
      />
    </FadeIn>
  );
}

async function ClaimsTable({
  page,
  perPage,
  type,
  search,
  icPeriod,
}: {
  page: number;
  perPage: number;
  type?: string;
  search?: string;
  icPeriod: InstantClaimPeriod;
}) {
  // safeQuery so a slow / failing claims scan degrades to an inline band +
  // empty table instead of throwing up the /rewards route boundary (which
  // blanks the WHOLE hub). Fallback is an empty page of claims.
  const { data: claims, error } = await safeQuery(
    () => getRakebackClaims({ page, perPage, type, search }),
    {
      data: [],
      total: 0,
      page,
      perPage,
      totalPages: 1,
    } as Awaited<ReturnType<typeof getRakebackClaims>>,
    "rakeback.claims",
    REWARD_QUERY_TIMEOUT_MS,
  );
  const failed = error !== null;

  function claimsTypeHref(t: string) {
    const p = new URLSearchParams({
      tab: "rakeback",
      rbtab: "claims",
      icPeriod,
      type: t,
    });
    if (search) p.set("search", search);
    return `/rewards?${p.toString()}`;
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-1 rounded-lg border bg-muted/50 p-1">
        {["all", "daily", "weekly", "monthly"].map((t) => (
          <Link
            key={t}
            href={claimsTypeHref(t)}
            className={cn(
              "inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium transition-colors capitalize",
              (type || "all") === t
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t}
            <LinkPending size={13} />
          </Link>
        ))}
      </div>
      {failed && <RakebackLoadErrorBand what="rakeback claims" />}
      <FadeIn>
        <RakebackClaimsTable data={claims.data} />
      </FadeIn>
      <DataTablePagination
        page={claims.page}
        totalPages={claims.totalPages}
        total={claims.total}
        perPage={claims.perPage}
        degraded={failed}
      />
    </div>
  );
}
