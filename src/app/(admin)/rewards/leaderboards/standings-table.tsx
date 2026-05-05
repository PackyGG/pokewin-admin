import Link from "next/link";
import { Trophy } from "lucide-react";
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

type Standing = {
  id: string;
  position: number;
  userId: string;
  username: string | null;
  wageredUsd: number;
};

const POSITION_COLORS: Record<number, string> = {
  1: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
  2: "bg-zinc-400/15 text-zinc-500 dark:text-zinc-400 border-zinc-400/30",
  3: "bg-amber-700/15 text-amber-700 dark:text-amber-500 border-amber-700/30",
};

function StandingMobileCard({ s }: { s: Standing }) {
  const positionColor =
    POSITION_COLORS[s.position] ??
    "bg-muted text-muted-foreground border-border";
  return (
    <div className="flex items-center gap-3 border-b border-border/60 last:border-b-0 px-3 py-3 hover:bg-muted/40 transition-colors">
      <div
        className={
          "flex size-9 shrink-0 items-center justify-center rounded-md text-xs font-semibold tabular-nums " +
          positionColor
        }
      >
        {s.position <= 3 ? <Trophy className="size-4" /> : `#${s.position}`}
      </div>
      <Link
        href={`/users/${s.userId}`}
        className="min-w-0 flex-1 text-sm font-medium hover:underline truncate"
      >
        {s.username ?? s.userId.slice(0, 8)}
      </Link>
      <div className="shrink-0 text-right">
        {/* Wager total ‒ neutral here (it's just a counter, not a P&L). */}
        <div className="text-sm font-medium tabular-nums">
          {formatCurrency(s.wageredUsd)}
        </div>
      </div>
    </div>
  );
}

export function StandingsTable({ data }: { data: Standing[] }) {
  return (
    <>
      {/* Mobile card list (<lg) */}
      <div className="lg:hidden">
        {data.length === 0 ? (
          <div className="flex h-24 items-center justify-center rounded-md border text-sm text-muted-foreground">
            No leaderboard data.
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border">
            {data.map((s) => (
              <StandingMobileCard key={s.id} s={s} />
            ))}
          </div>
        )}
      </div>

      {/* Desktop table (>=lg) */}
      <div className="hidden rounded-md border overflow-x-auto lg:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Position</TableHead>
              <TableHead>User</TableHead>
              <TableHead>Wagered</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((e) => (
              <TableRow key={e.id}>
                <TableCell>
                  <Badge variant="outline">#{e.position}</Badge>
                </TableCell>
                <TableCell>
                  <Link
                    href={`/users/${e.userId}`}
                    className="hover:underline"
                  >
                    {e.username ?? e.userId.slice(0, 8)}
                  </Link>
                </TableCell>
                <TableCell>{formatCurrency(e.wageredUsd)}</TableCell>
              </TableRow>
            ))}
            {data.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={3}
                  className="h-24 text-center text-muted-foreground"
                >
                  No leaderboard data.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
