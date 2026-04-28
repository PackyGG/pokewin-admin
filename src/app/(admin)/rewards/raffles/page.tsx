import Link from "next/link";
import { Ticket } from "lucide-react";
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
import { PageHero } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";

export const metadata = { title: "Raffles" };

const STATUS_COLORS: Record<string, string> = {
  active: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
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
    <div className="space-y-6">
      <PageHero>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
              <Ticket className="size-5 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold leading-tight">Raffles</h1>
              <p className="text-sm text-muted-foreground">
                Active and historic raffles — entries, participants, and winners.
              </p>
            </div>
          </div>
          <CreateRaffleButton />
        </div>
      </PageHero>

      <div className="space-y-4">
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

        <FadeIn>
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
        </FadeIn>

        <DataTablePagination
          page={raffles.page}
          totalPages={raffles.totalPages}
          total={raffles.total}
          perPage={raffles.perPage}
        />
      </div>
    </div>
  );
}
