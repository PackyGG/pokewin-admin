import Link from "next/link";
import { requirePageAccess } from "@/lib/dal";
import { getRaffles } from "@/lib/queries/raffles";
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
import { formatDateTime, formatNumber } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { CreateRaffleButton } from "./create-raffle-button";
import { CancelRaffleButton } from "./cancel-raffle-button";

const STATUS_COLORS: Record<string, string> = {
  active: "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30",
  completed: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  cancelled: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
};

export default async function RafflesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/rewards/raffles");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;

  const raffles = await getRaffles({
    page,
    perPage,
    status: params.status,
    search: params.search,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Raffles</h1>
        <CreateRaffleButton />
      </div>

      <div className="flex gap-1 rounded-lg bg-muted p-1">
        {["all", "active", "completed", "cancelled"].map((s) => (
          <Link
            key={s}
            href={`/rewards/raffles?status=${s}${params.search ? `&search=${params.search}` : ""}`}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors capitalize",
              (params.status || "all") === s
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {s}
          </Link>
        ))}
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Entries</TableHead>
              <TableHead>Participants</TableHead>
              <TableHead>Winner</TableHead>
              <TableHead>Starts</TableHead>
              <TableHead>Ends</TableHead>
              <TableHead className="w-[50px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {raffles.data.map((r) => (
              <TableRow key={r.id}>
                <TableCell>
                  <Link href={`/rewards/raffles/${r.id}`} className="font-medium hover:underline">
                    {r.name}
                  </Link>
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className={STATUS_COLORS[r.status] ?? ""}>
                    {r.status}
                  </Badge>
                </TableCell>
                <TableCell>{formatNumber(r.totalEntries)}</TableCell>
                <TableCell>{formatNumber(r.participantCount)}</TableCell>
                <TableCell>{r.winnerUsername ?? "-"}</TableCell>
                <TableCell>{formatDateTime(r.startsAt)}</TableCell>
                <TableCell>{formatDateTime(r.endsAt)}</TableCell>
                <TableCell>
                  {r.status === "active" && <CancelRaffleButton raffleId={r.id} />}
                </TableCell>
              </TableRow>
            ))}
            {raffles.data.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="h-24 text-center text-muted-foreground">No raffles found.</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <DataTablePagination
        page={raffles.page}
        totalPages={raffles.totalPages}
        total={raffles.total}
        perPage={raffles.perPage}
      />
    </div>
  );
}
