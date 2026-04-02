import { Suspense } from "react";
import Link from "next/link";
import { requirePageAccess } from "@/lib/dal";
import { getRaceLeaderboard } from "@/lib/queries/races";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { PeriodPicker } from "./period-picker";

function getDefaultPeriodStart(raceType: string): string {
  const now = new Date();
  if (raceType === "weekly") {
    const day = now.getDay();
    const diff = day === 0 ? 6 : day - 1;
    now.setDate(now.getDate() - diff);
  }
  return now.toISOString().slice(0, 10);
}

export default async function LeaderboardsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/rewards/leaderboards");
  const params = await searchParams;
  const raceType = params.raceType || "all";
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;
  const search = params.search;

  const effectivePeriod = raceType === "all" ? undefined : (params.periodStart || getDefaultPeriodStart(raceType));
  const result = await getRaceLeaderboard({ raceType, periodStart: effectivePeriod, search, page, perPage });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Leaderboards</h1>
      <div className="flex items-center gap-4">
        <div className="flex gap-1 rounded-lg bg-muted p-1">
          {["all", "daily", "weekly"].map((type) => (
            <Link
              key={type}
              href={`/rewards/leaderboards?raceType=${type}${type !== "all" && effectivePeriod ? `&periodStart=${effectivePeriod}` : ""}`}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors capitalize",
                raceType === type
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {type}
            </Link>
          ))}
        </div>
        {raceType !== "all" && effectivePeriod && (
          <PeriodPicker raceType={raceType} periodStart={effectivePeriod} />
        )}
      </div>
      <Suspense>
        <DataTableToolbar searchPlaceholder="Search by username, email, or ID..." />
      </Suspense>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Position</TableHead>
              <TableHead>User</TableHead>
              <TableHead>Wagered</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.data.map((e) => (
              <TableRow key={e.id}>
                <TableCell>
                  <Badge variant="outline">#{e.position}</Badge>
                </TableCell>
                <TableCell>
                  <Link href={`/users/${e.userId}`} className="hover:underline">
                    {e.username ?? e.userId.slice(0, 8)}
                  </Link>
                </TableCell>
                <TableCell>{formatCurrency(e.wageredUsd)}</TableCell>
              </TableRow>
            ))}
            {result.data.length === 0 && (
              <TableRow>
                <TableCell colSpan={3} className="h-24 text-center text-muted-foreground">No leaderboard data.</TableCell>
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
