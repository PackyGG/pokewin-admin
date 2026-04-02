import Link from "next/link";
import { requirePageAccess } from "@/lib/dal";
import { getRakebackConfigs, getRakebackClaims } from "@/lib/queries/rewards";
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
import { RakebackConfigTable } from "./rakeback-config-table";

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
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Rakeback</h1>
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

      {tab === "config" && <ConfigTab />}
      {tab === "claims" && <ClaimsTab page={page} perPage={perPage} type={params.type} search={params.search} />}
    </div>
  );
}

async function ConfigTab() {
  const configs = await getRakebackConfigs();
  return <RakebackConfigTable configs={configs} />;
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
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Period</TableHead>
              <TableHead>Wagered</TableHead>
              <TableHead>Rakeback</TableHead>
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
                  <Badge variant="outline" className="capitalize">{c.rakebackType}</Badge>
                </TableCell>
                <TableCell>{formatDateTime(c.periodStart)}</TableCell>
                <TableCell>{formatCurrency(c.wageredAmountUsd)}</TableCell>
                <TableCell>{formatCurrency(c.rakebackAmountUsd)}</TableCell>
                <TableCell>
                  {c.claimedAt ? (
                    <Badge variant="outline" className="bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30">
                      {formatDateTime(c.claimedAt)}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30">
                      Pending
                    </Badge>
                  )}
                </TableCell>
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
