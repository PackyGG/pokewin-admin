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
import { formatDateTime, formatRelative } from "@/lib/utils/format";
import { ListRowActions } from "./list-row-actions";
import type {
  LeaderboardAdminRow,
  ApprovalStatus,
  TimeStatus,
} from "@/lib/backend-api/affiliate-leaderboards";

const APPROVAL_COLORS: Record<ApprovalStatus, string> = {
  pending: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
  approved: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  rejected: "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30",
};

const TIME_COLORS: Record<TimeStatus, string> = {
  upcoming: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  active: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  ended: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
};

type CreatorInfo = { id: string; username: string | null; email: string | null };

function LeaderboardMobileCard({
  r,
  creator,
}: {
  r: LeaderboardAdminRow;
  creator: CreatorInfo | undefined;
}) {
  return (
    <div className="border-b border-border/60 last:border-b-0 px-3 py-3">
      <div className="flex items-start gap-3">
        <div className="flex size-9 items-center justify-center rounded-md bg-yellow-500/10 shrink-0">
          <Trophy className="size-4 text-yellow-500" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Link
              href={`/creators/leaderboards/${r.id}`}
              className="text-sm font-medium hover:underline truncate"
            >
              {r.title}
            </Link>
            {r.is_sponsored && (
              <Badge variant="outline" className="h-4 px-1 text-[9px]">
                sponsored
              </Badge>
            )}
          </div>
          <div className="mt-0.5 text-[11px] text-muted-foreground truncate">
            {creator
              ? creator.username ?? creator.email ?? r.creator_user_id.slice(0, 8)
              : r.creator_user_id.slice(0, 12)}
            {r.co_creator_user_ids?.length > 0 && (
              <span className="ml-1">+{r.co_creator_user_ids.length} co-creator{r.co_creator_user_ids.length > 1 ? "s" : ""}</span>
            )}
          </div>
          <div className="mt-1 flex items-center gap-1.5 flex-wrap">
            <Badge
              variant="outline"
              className={
                "h-4 px-1 text-[9px] " + APPROVAL_COLORS[r.approval_status]
              }
            >
              {r.approval_status}
            </Badge>
            <Badge
              variant="outline"
              className={
                "h-4 px-1 text-[9px] " + TIME_COLORS[r.time_status]
              }
            >
              {r.time_status}
            </Badge>
            {r.cancelled_at && (
              <Badge
                variant="outline"
                className="h-4 px-1 text-[9px] bg-zinc-500/15 text-zinc-600 border-zinc-500/30"
              >
                cancelled
              </Badge>
            )}
          </div>
          <div className="mt-1 text-[10px] text-muted-foreground">
            {formatRelative(r.start_date)} → {formatRelative(r.end_date)}
          </div>
        </div>
        <div className="shrink-0 text-right space-y-1">
          {/* Total prize = house+creator paid → rose. */}
          <div className="text-sm font-medium tabular-nums text-rose-600 dark:text-rose-400">
            ${r.total_prize_usd}
          </div>
          <div className="text-[10px] text-muted-foreground tabular-nums">
            ${r.creator_prize_usd} + ${r.site_bonus_usd}
          </div>
          <ListRowActions row={r} />
        </div>
      </div>
    </div>
  );
}

export function LeaderboardsTable({
  rows,
  creatorMap,
}: {
  rows: LeaderboardAdminRow[];
  creatorMap: Map<string, CreatorInfo>;
}) {
  return (
    <>
      {/* Mobile card list (<lg) */}
      <div className="lg:hidden">
        {rows.length === 0 ? (
          <div className="flex h-24 items-center justify-center rounded-md border text-sm text-muted-foreground">
            No leaderboards found for this filter.
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border">
            {rows.map((r) => (
              <LeaderboardMobileCard
                key={r.id}
                r={r}
                creator={creatorMap.get(r.creator_user_id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Desktop table (>=lg) */}
      <div className="hidden rounded-md border overflow-x-auto lg:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead>Creator</TableHead>
              <TableHead>Approval</TableHead>
              <TableHead>Time</TableHead>
              <TableHead className="text-right">Creator $</TableHead>
              <TableHead className="text-right">Bonus $</TableHead>
              <TableHead className="text-right">Total $</TableHead>
              <TableHead>Starts</TableHead>
              <TableHead>Ends</TableHead>
              <TableHead className="w-[200px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={10}
                  className="text-center text-muted-foreground py-8"
                >
                  No leaderboards found for this filter.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => {
                const creator = creatorMap.get(r.creator_user_id);
                return (
                  <TableRow key={r.id}>
                    <TableCell>
                      <Link
                        href={`/creators/leaderboards/${r.id}`}
                        className="font-medium hover:underline"
                      >
                        {r.title}
                      </Link>
                      {r.is_sponsored && (
                        <Badge variant="outline" className="ml-2 text-xs">
                          sponsored
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {creator ? (
                        <div className="flex flex-col">
                          <span className="text-sm">
                            {creator.username ?? "(no username)"}
                          </span>
                          <span className="text-xs text-muted-foreground font-mono">
                            {r.creator_user_id.slice(0, 12)}…
                          </span>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground font-mono">
                          {r.creator_user_id}
                        </span>
                      )}
                      {r.co_creator_user_ids?.length > 0 && (
                        <Badge variant="outline" className="mt-1 text-[10px]">
                          +{r.co_creator_user_ids.length} co-creator{r.co_creator_user_ids.length > 1 ? "s" : ""}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={APPROVAL_COLORS[r.approval_status]}
                      >
                        {r.approval_status}
                      </Badge>
                      {r.cancelled_at && (
                        <Badge
                          variant="outline"
                          className="ml-2 bg-zinc-500/15 text-zinc-600 border-zinc-500/30"
                        >
                          cancelled
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={TIME_COLORS[r.time_status]}
                      >
                        {r.time_status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      ${r.creator_prize_usd}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      ${r.site_bonus_usd}
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-semibold">
                      ${r.total_prize_usd}
                    </TableCell>
                    <TableCell className="text-xs">
                      {formatDateTime(r.start_date)}
                    </TableCell>
                    <TableCell className="text-xs">
                      {formatDateTime(r.end_date)}
                    </TableCell>
                    <TableCell>
                      <ListRowActions row={r} />
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
