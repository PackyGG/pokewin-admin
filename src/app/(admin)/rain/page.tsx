import { Suspense } from "react";
import Link from "next/link";
import { CloudRain } from "lucide-react";
import { getRains } from "@/lib/queries/rain";
import { getSiteConfigValues } from "@/lib/queries/site-config";
import { requirePageAccess } from "@/lib/dal";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { Skeleton } from "@/components/ui/skeleton";
import {
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";
import { cn } from "@/lib/utils";
import { RainRangeFilters } from "./range-filters";
import { RainsTable } from "./rains-table";
import { RAIN_CONFIG_KEYS } from "./config-keys";
import { RainConfigCard } from "./rain-config-card";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";

export const metadata = { title: "Rain" };

const TABS = [
  { value: "instances", label: "Instances" },
  { value: "config", label: "Config" },
] as const;

type TabValue = (typeof TABS)[number]["value"];

export default async function RainPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/rain");
  const params = await searchParams;
  const tab: TabValue = (
    TABS.find((t) => t.value === params.tab) ?? TABS[0]
  ).value;

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={CloudRain}
          title="Rain"
          subtitle="Community rain instances — pools, tips, and winners."
        />
      </PageHero>

      <div className="space-y-4">
        <div className="flex flex-wrap gap-1 rounded-lg bg-muted p-1 w-fit">
          {TABS.map((t) => (
            <Link
              key={t.value}
              href={`/rain?tab=${t.value}`}
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

        {tab === "instances" && (
          <InstancesTab params={params} />
        )}
        {tab === "config" && <ConfigTab />}
      </div>
    </div>
  );
}

function InstancesTab({
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

  const rains = await getRains({
    page,
    perPage,
    search: params.search,
    status: params.status,
    minTips: params.minTips ? Number(params.minTips) : undefined,
    maxTips: params.maxTips ? Number(params.maxTips) : undefined,
    minPool: params.minPool ? Number(params.minPool) : undefined,
    maxPool: params.maxPool ? Number(params.maxPool) : undefined,
    minParticipants: params.minParticipants ? Number(params.minParticipants) : undefined,
    maxParticipants: params.maxParticipants ? Number(params.maxParticipants) : undefined,
  });

  return (
    <>
      <FadeIn>
        <RainsTable data={rains.data} />
      </FadeIn>

      <DataTablePagination
        page={rains.page}
        totalPages={rains.totalPages}
        total={rains.total}
        perPage={rains.perPage}
      />
    </>
  );
}

async function ConfigTab() {
  // Read current values straight from site_config — empty strings /
  // missing rows mean "not configured yet" and the UI shows an empty
  // input so the admin can set them for the first time.
  const values = await getSiteConfigValues([
    RAIN_CONFIG_KEYS.defaultBaseAmount,
    RAIN_CONFIG_KEYS.liveBaseAmount,
    RAIN_CONFIG_KEYS.durationMinutes,
    RAIN_CONFIG_KEYS.frequencyMs,
  ]);

  function parseNumber(raw: string | undefined): number | null {
    return raw != null && raw !== "" && Number.isFinite(Number(raw))
      ? Number(raw)
      : null;
  }

  const defaultBaseAmountUsd = parseNumber(
    values[RAIN_CONFIG_KEYS.defaultBaseAmount],
  );
  const liveBaseAmountUsd = parseNumber(
    values[RAIN_CONFIG_KEYS.liveBaseAmount],
  );
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
