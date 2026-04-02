import Link from "next/link";
import { Suspense } from "react";
import { getVouchers, getVoucherCreators } from "@/lib/queries/vouchers";
import { requirePageAccess } from "@/lib/dal";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency, formatDate, formatDateTime } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { ValueRangeFilter } from "./value-range-filter";

export default async function VouchersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/vouchers");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;
  const tab = params.tab || "unclaimed";

  const claimed = tab === "claimed";

  const [result, creators] = await Promise.all([
    getVouchers({
      page,
      perPage,
      claimed,
      search: params.search,
      minValue: params.minValue ? Number(params.minValue) : undefined,
      maxValue: params.maxValue ? Number(params.maxValue) : undefined,
      createdBy: params.createdBy,
    }),
    getVoucherCreators(),
  ]);

  const createdByOptions = [
    { label: "System", value: "system" },
    ...creators.map((c) => ({ label: c.username, value: c.id })),
  ];

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Vouchers</h1>

      <div className="flex gap-1 rounded-lg bg-muted p-1 w-fit">
        {[
          { value: "unclaimed", label: "Unclaimed" },
          { value: "claimed", label: "Claimed" },
        ].map((t) => (
          <Link
            key={t.value}
            href={`/vouchers?tab=${t.value}`}
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

      <Suspense fallback={<Skeleton className="h-10 w-full" />}>
        <DataTableToolbar
          searchPlaceholder="Search by username or email..."
          filters={[
            {
              name: "Created By",
              paramKey: "createdBy",
              options: createdByOptions,
            },
          ]}
        >
          <ValueRangeFilter />
        </DataTableToolbar>
      </Suspense>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Value</TableHead>
              <TableHead>Origin</TableHead>
              <TableHead>Created By</TableHead>
              <TableHead>Description</TableHead>
              {claimed && <TableHead>FTD</TableHead>}
              {claimed && <TableHead>Claimed At</TableHead>}
              <TableHead>Created At</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.data.map((v) => (
              <TableRow key={v.id}>
                <TableCell>
                  <Link href={`/users/${v.userId}`} className="hover:underline">
                    {v.username ?? v.userId.slice(0, 8)}
                  </Link>
                </TableCell>
                <TableCell>{formatCurrency(v.value)}</TableCell>
                <TableCell>
                  <Badge variant="outline">{v.originLabel}</Badge>
                </TableCell>
                <TableCell>
                  {v.createdByAdminId ? (
                    <Link href={`/admin-users/${v.createdByAdminId}`} className="hover:underline">
                      {v.createdByUsername}
                    </Link>
                  ) : "System"}
                </TableCell>
                <TableCell className="max-w-xs truncate">{v.description ?? "-"}</TableCell>
                {claimed && (
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={
                        v.isFtd
                          ? "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30"
                          : "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30"
                      }
                    >
                      {v.isFtd ? "Yes" : "No"}
                    </Badge>
                  </TableCell>
                )}
                {claimed && (
                  <TableCell>{v.claimedAt ? formatDateTime(v.claimedAt) : "-"}</TableCell>
                )}
                <TableCell>{formatDate(v.createdAt)}</TableCell>
              </TableRow>
            ))}
            {result.data.length === 0 && (
              <TableRow>
                <TableCell colSpan={claimed ? 8 : 6} className="h-24 text-center">
                  No vouchers found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <DataTablePagination
        page={result.page}
        totalPages={result.totalPages}
        total={result.total}
        perPage={result.perPage}
      />
    </div>
  );
}
