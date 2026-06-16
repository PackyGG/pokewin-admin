import Link from "next/link";
import { CloudRain } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency, formatDateTime, formatRelative } from "@/lib/utils/format";
import { EmptyState } from "@/components/empty-state";
import { InlineBaseCell } from "./inline-base-cell";

const RAIN_STATUS_COLORS: Record<string, string> = {
  active:
    "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  drawing:
    "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
  completed: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  cancelled:
    "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
};

type RainRow = {
  id: string;
  status: string;
  baseAmountUsd: number;
  tipAmountUsd: number;
  totalPoolUsd: number;
  participantCount: number;
  winnerUsername: string | null;
  startsAt: string;
  endsAt: string;
};

function RainMobileCard({ r }: { r: RainRow }) {
  return (
    <div className="border-b border-border/60 last:border-b-0">
      <Link
        href={`/rain/${r.id}`}
        className="flex items-start gap-3 px-3 py-3 hover:bg-muted/40 active:bg-muted/60 transition-colors min-h-[56px]"
      >
        <div className="flex size-9 items-center justify-center rounded-md bg-blue-500/10 shrink-0">
          <CloudRain className="size-4 text-blue-500" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-xs">{r.id.slice(0, 8)}…</span>
            <Badge
              variant="outline"
              className={
                "h-4 px-1 text-[9px] capitalize " +
                (RAIN_STATUS_COLORS[r.status] ?? "")
              }
            >
              {r.status}
            </Badge>
          </div>
          <div className="mt-1 grid grid-cols-2 gap-x-3 text-[11px] text-muted-foreground">
            <div>
              <span className="text-[9px] uppercase tracking-wide">
                Participants
              </span>
              <div className="tabular-nums">{r.participantCount}</div>
            </div>
            <div>
              <span className="text-[9px] uppercase tracking-wide">Tips</span>
              <div className="tabular-nums">{formatCurrency(r.tipAmountUsd)}</div>
            </div>
          </div>
          {r.winnerUsername && (
            <div className="mt-1 text-[10px] text-muted-foreground truncate">
              Winner: <span className="font-medium">{r.winnerUsername}</span>
            </div>
          )}
          <div className="mt-1 text-[10px] text-muted-foreground">
            {formatRelative(r.startsAt)} → {formatRelative(r.endsAt)}
          </div>
        </div>
        <div className="shrink-0 text-right">
          {/* Pool = house+tips that get paid out → rose. */}
          <div className="text-sm font-medium tabular-nums text-rose-600 dark:text-rose-400">
            {formatCurrency(r.totalPoolUsd)}
          </div>
        </div>
      </Link>
    </div>
  );
}

export function RainsTable({ data }: { data: RainRow[] }) {
  return (
    <>
      {/* Mobile card list (<lg) */}
      <div className="lg:hidden">
        {data.length === 0 ? (
          <div className="rounded-md border">
            <EmptyState
              icon={CloudRain}
              title="No rains found"
              description="Rain events appear here once they are scheduled or run on the platform."
              compact
            />
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border">
            {data.map((r) => (
              <RainMobileCard key={r.id} r={r} />
            ))}
          </div>
        )}
      </div>

      {/* Desktop table (>=lg) */}
      <div className="hidden rounded-md border overflow-x-auto lg:block">
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
            {data.map((r) => (
              <TableRow key={r.id} className="cursor-pointer hover:bg-muted/50">
                <TableCell className="font-mono text-xs">
                  <Link href={`/rain/${r.id}`} className="hover:underline">
                    {r.id.slice(0, 8)}...
                  </Link>
                </TableCell>
                <TableCell>
                  <Badge
                    variant="outline"
                    className={RAIN_STATUS_COLORS[r.status] ?? ""}
                  >
                    {r.status}
                  </Badge>
                </TableCell>
                <TableCell>
                  <InlineBaseCell
                    rainId={r.id}
                    value={r.baseAmountUsd}
                    isActive={r.status === "active"}
                  />
                </TableCell>
                <TableCell className="tabular-nums text-rose-600 dark:text-rose-400">
                  {formatCurrency(r.tipAmountUsd)}
                </TableCell>
                <TableCell className="tabular-nums text-rose-600 dark:text-rose-400">
                  {formatCurrency(r.totalPoolUsd)}
                </TableCell>
                <TableCell>{r.participantCount}</TableCell>
                <TableCell>{r.winnerUsername ?? "-"}</TableCell>
                <TableCell>{formatDateTime(r.startsAt)}</TableCell>
                <TableCell>{formatDateTime(r.endsAt)}</TableCell>
              </TableRow>
            ))}
            {data.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={9} className="p-0">
                  <EmptyState
                    icon={CloudRain}
                    title="No rains found"
                    description="Rain events appear here once they are scheduled or run on the platform."
                    compact
                  />
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
