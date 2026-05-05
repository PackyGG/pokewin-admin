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
import { formatCurrency, formatDateTime, formatRelative } from "@/lib/utils/format";

type Claim = {
  id: string;
  userId: string;
  username: string | null;
  raceType: string;
  position: number;
  prizeAmountUsd: number;
  racePeriodStart: string;
  claimedAt: string;
};

function ClaimMobileCard({ c }: { c: Claim }) {
  return (
    <div className="border-b border-border/60 last:border-b-0 px-3 py-3 hover:bg-muted/40 transition-colors">
      <div className="flex items-start gap-3">
        <div className="flex size-9 items-center justify-center rounded-md bg-yellow-500/10 shrink-0">
          <Trophy className="size-4 text-yellow-500" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Link
              href={`/users/${c.userId}`}
              className="text-sm font-medium hover:underline truncate"
            >
              {c.username ?? c.userId.slice(0, 8)}
            </Link>
            <Badge variant="outline" className="h-4 px-1 text-[9px] capitalize">
              {c.raceType}
            </Badge>
            <Badge variant="outline" className="h-4 px-1 text-[9px]">
              #{c.position}
            </Badge>
          </div>
          <div className="mt-1 text-[10px] text-muted-foreground">
            Period {formatRelative(c.racePeriodStart)}
            {" · Claimed "}
            {formatRelative(c.claimedAt)}
          </div>
        </div>
        <div className="shrink-0 text-right">
          {/* Prize = house-paid → rose. */}
          <div className="text-sm font-medium tabular-nums text-rose-600 dark:text-rose-400">
            {formatCurrency(c.prizeAmountUsd)}
          </div>
        </div>
      </div>
    </div>
  );
}

export function HistoryTable({ data }: { data: Claim[] }) {
  return (
    <>
      {/* Mobile card list (<lg) */}
      <div className="lg:hidden">
        {data.length === 0 ? (
          <div className="flex h-24 items-center justify-center rounded-md border text-sm text-muted-foreground">
            No claims found.
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border">
            {data.map((c) => (
              <ClaimMobileCard key={c.id} c={c} />
            ))}
          </div>
        )}
      </div>

      {/* Desktop table (>=lg) */}
      <div className="hidden rounded-md border overflow-x-auto lg:block">
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
            {data.map((c) => (
              <TableRow key={c.id}>
                <TableCell>
                  <Link
                    href={`/users/${c.userId}`}
                    className="hover:underline"
                  >
                    {c.username ?? c.userId.slice(0, 8)}
                  </Link>
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className="capitalize">
                    {c.raceType}
                  </Badge>
                </TableCell>
                <TableCell>#{c.position}</TableCell>
                <TableCell>{formatCurrency(c.prizeAmountUsd)}</TableCell>
                <TableCell>{formatDateTime(c.racePeriodStart)}</TableCell>
                <TableCell>{formatDateTime(c.claimedAt)}</TableCell>
              </TableRow>
            ))}
            {data.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="h-24 text-center text-muted-foreground"
                >
                  No claims found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
