import { Suspense } from "react";
import Link from "next/link";
import { getRains } from "@/lib/queries/rain";
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
import { RainRangeFilters } from "./range-filters";
import { InlineBaseCell } from "./inline-base-cell";

const RAIN_STATUS_COLORS: Record<string, string> = {
  active: "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30",
  drawing: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
  completed: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  cancelled: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
};

export default async function RainPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/rain");
  const params = await searchParams;
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
      <h1 className="text-2xl font-bold">Rain</h1>

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
