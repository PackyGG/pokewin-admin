import { Suspense } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { getRains } from "@/lib/queries/rain";
import { getSiteConfigValues } from "@/lib/queries/site-config";
import { safeQuery } from "@/lib/errors/safe-query";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { Skeleton } from "@/components/ui/skeleton";
import {
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";
import { cn } from "@/lib/utils";
import { RainRangeFilters } from "../rain/range-filters";
import { RainsTable } from "../rain/rains-table";
import { RAIN_CONFIG_KEYS } from "../rain/config-keys";
import { RainConfigCard } from "../rain/rain-config-card";
import { FadeIn } from "@/components/fade-in";
import { LinkPendingShell } from "@/components/ux";

/**
 * Inline "couldn't load" band — mirrors the amber notice the Challenges tab
 * renders when its safeQuery-wrapped read fails, so a slow / failing Rain read
 * degrades to a per-tab notice instead of throwing to the /rewards route error
 * boundary.
 */
function RainLoadErrorBand({ what }: { what: string }) {
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

/**
 * Rain tab of the merged /rewards page (was the standalone /rain LIST page).
 *
 * The Rain tab has its OWN inner Instances/Config switch. To avoid colliding
 * with the top-level Rain|Challenges switch (which drives `?tab=`), the inner
 * switch drives `?rtab=` instead. Only the active inner sub-tab awaits its data
 * (active-tab-only, CLAUDE.md).
 *
 * Rows still link to /rain/[id] (the detail route is unchanged).
 */
const RAIN_SUBTABS = [
  { value: "instances", label: "Instances" },
  { value: "config", label: "Config" },
] as const;

type RainSubTab = (typeof RAIN_SUBTABS)[number]["value"];

export function RainTab({
  params,
}: {
  params: Record<string, string | undefined>;
}) {
  const subTab: RainSubTab = (
    RAIN_SUBTABS.find((t) => t.value === params.rtab) ?? RAIN_SUBTABS[0]
  ).value;

  return (
    <div className="space-y-4">
      <div className="-mx-1 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="inline-flex gap-1 rounded-lg bg-muted p-1">
          {RAIN_SUBTABS.map((t) => (
            <Link
              key={t.value}
              href={`/rewards?tab=rain&rtab=${t.value}`}
              className={cn(
                "shrink-0 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                subTab === t.value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <LinkPendingShell spinnerSize={13}>{t.label}</LinkPendingShell>
            </Link>
          ))}
        </div>
      </div>

      {subTab === "instances" && <InstancesSubTab params={params} />}
      {subTab === "config" && <ConfigSubTab />}
    </div>
  );
}

function InstancesSubTab({
  params,
}: {
  params: Record<string, string | undefined>;
}) {
  const suspenseKey = `${params.page ?? "1"}|${params.perPage ?? "20"}|${params.search ?? ""}|${params.status ?? ""}|${params.minTips ?? ""}|${params.maxTips ?? ""}|${params.minPool ?? ""}|${params.maxPool ?? ""}|${params.minParticipants ?? ""}|${params.maxParticipants ?? ""}`;

  return (
    <div className="space-y-4">
      <Suspense fallback={<Skeleton className="h-10 w-full" />}>
        <DataTableToolbar
          searchPlaceholder="Search by ID or winner..."
          filters={[
            {
              name: "Status",
              paramKey: "status",
              options: [
                { label: "Active", value: "active" },
                { label: "Drawing", value: "drawing" },
                { label: "Completed", value: "completed" },
                { label: "Cancelled", value: "cancelled" },
              ],
            },
          ]}
        >
          <RainRangeFilters />
        </DataTableToolbar>
      </Suspense>

      <Suspense
        key={suspenseKey}
        fallback={
          <>
            <TableSkeleton rows={12} columns={9} />
            <PaginationSkeleton />
          </>
        }
      >
        <RainsTableAsync params={params} />
      </Suspense>
    </div>
  );
}

async function RainsTableAsync({
  params,
}: {
  params: Record<string, string | undefined>;
}) {
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;

  // Wrap in safeQuery so a slow / failing rain-list read degrades to an empty
  // table + an inline amber band instead of throwing the whole /rewards page
  // into the route error boundary (matches the Challenges tab pattern).
  const { data: rains, error } = await safeQuery(
    () =>
      getRains({
        page,
        perPage,
        search: params.search,
        status: params.status,
        minTips: params.minTips ? Number(params.minTips) : undefined,
        maxTips: params.maxTips ? Number(params.maxTips) : undefined,
        minPool: params.minPool ? Number(params.minPool) : undefined,
        maxPool: params.maxPool ? Number(params.maxPool) : undefined,
        minParticipants: params.minParticipants
          ? Number(params.minParticipants)
          : undefined,
        maxParticipants: params.maxParticipants
          ? Number(params.maxParticipants)
          : undefined,
      }),
    { data: [], total: 0, page, perPage, totalPages: 1 },
    "rain.list",
    15_000,
  );
  const failed = error !== null;

  return (
    <>
      {failed && <RainLoadErrorBand what="rains" />}

      <FadeIn>
        <RainsTable data={rains.data} />
      </FadeIn>

      <DataTablePagination
        page={rains.page}
        totalPages={rains.totalPages}
        total={rains.total}
        perPage={rains.perPage}
        degraded={failed}
      />
    </>
  );
}

async function ConfigSubTab() {
  // Read current values straight from site_config — empty strings /
  // missing rows mean "not configured yet" and the UI shows an empty
  // input so the admin can set them for the first time.
  //
  // Wrapped in safeQuery: a failing site_config read degrades to an inline
  // amber band instead of throwing the whole /rewards page into the route
  // error boundary.
  const { data: values, error } = await safeQuery(
    () =>
      getSiteConfigValues([
        RAIN_CONFIG_KEYS.defaultBaseAmount,
        RAIN_CONFIG_KEYS.liveBaseAmount,
        RAIN_CONFIG_KEYS.durationMinutes,
        RAIN_CONFIG_KEYS.frequencyMs,
      ]),
    {} as Record<string, string>,
    "rain.config",
    15_000,
  );

  if (error !== null) {
    return <RainLoadErrorBand what="rain config" />;
  }

  function parseNumber(raw: string | undefined): number | null {
    return raw != null && raw !== "" && Number.isFinite(Number(raw))
      ? Number(raw)
      : null;
  }

  const defaultBaseAmountUsd = parseNumber(
    values[RAIN_CONFIG_KEYS.defaultBaseAmount],
  );
  const liveBaseAmountUsd = parseNumber(values[RAIN_CONFIG_KEYS.liveBaseAmount]);
  const durationMinutes = parseNumber(values[RAIN_CONFIG_KEYS.durationMinutes]);
  const frequencyMs = parseNumber(values[RAIN_CONFIG_KEYS.frequencyMs]);

  return (
    <FadeIn>
      <RainConfigCard
        initial={{
          defaultBaseAmountUsd,
          liveBaseAmountUsd,
          durationMinutes,
          frequencyMs,
        }}
      />
    </FadeIn>
  );
}
