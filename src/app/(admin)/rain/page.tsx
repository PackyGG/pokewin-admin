import { Suspense } from "react";
import Link from "next/link";
import { getRains } from "@/lib/queries/rain";
import { getSiteConfigValues } from "@/lib/queries/site-config";
import { requirePageAccess } from "@/lib/dal";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
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
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { RainRangeFilters } from "./range-filters";
import { InlineBaseCell } from "./inline-base-cell";
import { RAIN_CONFIG_KEYS } from "./config-keys";
import { RainConfigCard } from "./rain-config-card";

const RAIN_STATUS_COLORS: Record<string, string> = {
  active: "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30",
  drawing: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
  completed: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  cancelled: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
};

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
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Rain</h1>

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

      {tab === "instances" && <InstancesTab params={params} />}
      {tab === "config" && <ConfigTab />}
    </div>
  );
}

async function InstancesTab({
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

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Base</TableHead>
              <TableHead>Tips</TableHead>
              <TableHead>Total Pool</TableHead>
              <TableHead>Participants</TableHead>
              <TableHead>Winner</TableHead>
              <TableHead>Starts</TableHead>
              <TableHead>Ends</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rains.data.map((r) => (
              <TableRow key={r.id} className="cursor-pointer hover:bg-muted/50">
                <TableCell className="font-mono text-xs">
                  <Link href={`/rain/${r.id}`} className="hover:underline">
                    {r.id.slice(0, 8)}...
                  </Link>
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className={RAIN_STATUS_COLORS[r.status] ?? ""}>
                    {r.status}
                  </Badge>
                </TableCell>
                <TableCell>
                  <InlineBaseCell rainId={r.id} value={r.baseAmountUsd} isActive={r.status === "active"} />
                </TableCell>
                <TableCell>{formatCurrency(r.tipAmountUsd)}</TableCell>
                <TableCell>{formatCurrency(r.totalPoolUsd)}</TableCell>
                <TableCell>{r.participantCount}</TableCell>
                <TableCell>{r.winnerUsername ?? "-"}</TableCell>
                <TableCell>{formatDateTime(r.startsAt)}</TableCell>
                <TableCell>{formatDateTime(r.endsAt)}</TableCell>
              </TableRow>
            ))}
            {rains.data.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="h-24 text-center">No rains found.</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <DataTablePagination
        page={rains.page}
        totalPages={rains.totalPages}
        total={rains.total}
        perPage={rains.perPage}
      />
    </div>
  );
}

async function ConfigTab() {
  // Read current values straight from site_config — empty strings /
  // missing rows mean "not configured yet" and the UI shows an empty
  // input so the admin can set them for the first time.
  const values = await getSiteConfigValues([
    RAIN_CONFIG_KEYS.defaultBaseAmount,
    RAIN_CONFIG_KEYS.durationMinutes,
  ]);

  const rawBase = values[RAIN_CONFIG_KEYS.defaultBaseAmount];
  const rawDuration = values[RAIN_CONFIG_KEYS.durationMinutes];

  const defaultBaseAmountUsd =
    rawBase != null && rawBase !== "" && Number.isFinite(Number(rawBase))
      ? Number(rawBase)
      : null;
  const durationMinutes =
    rawDuration != null && rawDuration !== "" && Number.isFinite(Number(rawDuration))
      ? Number(rawDuration)
      : null;

  return (
    <RainConfigCard
      initial={{ defaultBaseAmountUsd, durationMinutes }}
    />
  );
}
