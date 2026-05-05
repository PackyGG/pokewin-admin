import Link from "next/link";
import { Ticket } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime, formatNumber, formatRelative } from "@/lib/utils/format";
import { CancelRaffleButton } from "./cancel-raffle-button";

const STATUS_COLORS: Record<string, string> = {
  active:
    "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  completed: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  cancelled:
    "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
};

type Raffle = {
  id: string;
  name: string;
  status: string;
  totalEntries: number;
  participantCount: number;
  winnerUsername: string | null;
  startsAt: string;
  endsAt: string;
};

function RaffleMobileCard({ r }: { r: Raffle }) {
  const now = Date.now();
  const ends = new Date(r.endsAt).getTime();
  const ended = ends < now;
  return (
    <div className="border-b border-border/60 last:border-b-0 px-3 py-3">
      <div className="flex items-start gap-3">
        <div className="flex size-9 items-center justify-center rounded-md bg-amber-500/10 shrink-0">
          <Ticket className="size-4 text-amber-500" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Link
              href={`/rewards/raffles/${r.id}`}
              className="text-sm font-medium hover:underline truncate"
            >
              {r.name}
            </Link>
            <Badge
              variant="outline"
              className={"h-4 px-1 text-[9px] capitalize " + (STATUS_COLORS[r.status] ?? "")}
            >
              {r.status}
            </Badge>
          </div>
          <div className="mt-1 grid grid-cols-2 gap-x-3 text-[11px] text-muted-foreground">
            <div>
              <span className="text-[9px] uppercase tracking-wide">Entries</span>
              <div className="tabular-nums">{formatNumber(r.totalEntries)}</div>
            </div>
            <div>
              <span className="text-[9px] uppercase tracking-wide">People</span>
              <div className="tabular-nums">{formatNumber(r.participantCount)}</div>
            </div>
          </div>
          <div className="mt-1 text-[10px] text-muted-foreground">
            {ended ? "Ended" : "Ends"} {formatRelative(r.endsAt)}
            {r.winnerUsername && (
              <>
                {" · Winner: "}
                <span className="font-medium">{r.winnerUsername}</span>
              </>
            )}
          </div>
        </div>
        <div className="shrink-0 flex flex-col items-end gap-1">
          {r.status === "active" && <CancelRaffleButton raffleId={r.id} />}
        </div>
      </div>
    </div>
  );
}

export function RafflesTable({ data }: { data: Raffle[] }) {
  return (
    <>
      {/* Mobile card list (<lg) */}
      <div className="lg:hidden">
        {data.length === 0 ? (
          <div className="flex h-24 items-center justify-center rounded-md border text-sm text-muted-foreground">
            No raffles found.
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border">
            {data.map((r) => (
              <RaffleMobileCard key={r.id} r={r} />
            ))}
          </div>
        )}
      </div>

      {/* Desktop table (>=lg) */}
      <div className="hidden rounded-md border overflow-x-auto lg:block">
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
            {data.map((r) => (
              <TableRow key={r.id}>
                <TableCell>
                  <Link
                    href={`/rewards/raffles/${r.id}`}
                    className="font-medium hover:underline"
                  >
                    {r.name}
                  </Link>
                </TableCell>
                <TableCell>
                  <Badge
                    variant="outline"
                    className={STATUS_COLORS[r.status] ?? ""}
                  >
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
            {data.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={8}
                  className="h-24 text-center text-muted-foreground"
                >
                  No raffles found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
