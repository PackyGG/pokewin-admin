import Link from "next/link";
import { requirePageAccess } from "@/lib/dal";
import { getRacePrizeTiers, getRaceClaims } from "@/lib/queries/races";
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
import { formatCurrency, formatDateTime } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { RaceTiersTable } from "./race-tiers-table";

const TABS = [
  { value: "claims", label: "Claims" },
  { value: "tiers", label: "Prize Tiers" },
];

export default async function RacesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/rewards/races");
  const params = await searchParams;
  const tab = params.tab || "claims";
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;
  const raceType = params.raceType;

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Races</h1>
      <div className="flex gap-1 rounded-lg bg-muted p-1">
        {TABS.map((t) => (
          <Link
            key={t.value}
            href={`/rewards/races?tab=${t.value}`}
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

      {tab === "tiers" && <TiersTab />}
      {tab === "claims" && <ClaimsTab page={page} perPage={perPage} raceType={raceType} />}
    </div>
  );
}

async function TiersTab() {
  const tiers = await getRacePrizeTiers();
  return <RaceTiersTable tiers={tiers} />;
}

async function ClaimsTab({ page, perPage, raceType }: { page: number; perPage: number; raceType?: string }) {
  const claims = await getRaceClaims({ page, perPage, raceType });

  return (
    <>
      <div className="flex gap-1 rounded-lg bg-muted p-1">
        {["all", "daily", "weekly"].map((type) => (
          <Link
            key={type}
            href={`/rewards/races?tab=claims&raceType=${type}`}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors capitalize",
              (raceType || "all") === type
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {type}
          </Link>
        ))}
      </div>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Position</TableHead>
              <TableHead>Prize</TableHead>
              <TableHead>Period</TableHead>
              <TableHead>Claimed</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {claims.data.map((c) => (
              <TableRow key={c.id}>
                <TableCell>
                  <Link href={`/users/${c.userId}`} className="hover:underline">
                    {c.username ?? c.userId.slice(0, 8)}
                  </Link>
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className="capitalize">{c.raceType}</Badge>
                </TableCell>
                <TableCell>#{c.position}</TableCell>
                <TableCell>{formatCurrency(c.prizeAmountUsd)}</TableCell>
                <TableCell>{formatDateTime(c.racePeriodStart)}</TableCell>
                <TableCell>{formatDateTime(c.claimedAt)}</TableCell>
              </TableRow>
            ))}
            {claims.data.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">No claims found.</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <DataTablePagination
        page={claims.page}
        totalPages={claims.totalPages}
        total={claims.total}
        perPage={claims.perPage}
      />
    </>
  );
}
