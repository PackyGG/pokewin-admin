"use client";

import { useState } from "react";
import Link from "next/link";
import { History, Trophy } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { formatCurrency, formatDate } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

import {
  LEADERBOARD_APPROVAL_COLORS,
  LEADERBOARD_TIME_COLORS,
  type LeaderboardApprovalStatus,
  type LeaderboardTimeStatus,
} from "./status-badges";

export type PreviousLeaderboardItem = {
  id: string;
  title: string;
  total_prize_usd: string;
  is_sponsored: boolean;
  start_date: string;
  end_date: string;
  approval_status: LeaderboardApprovalStatus;
  time_status: LeaderboardTimeStatus;
  /** Admin sponsored share of the prize pool (0–100, default 100). */
  sponsoredPct: number;
  /** House-funded prize spend = prize × sponsoredPct → rose. */
  houseCostUsd: number;
  /** Raw (unweighted) wager driven by the board's codes in its window. */
  wageredRawUsd: number;
  /** Leaderboard-weighted wager (settled boards: the snapshot total). */
  wageredWeightedUsd: number;
};

/**
 * "Previous leaderboards" modal — read-only history of this creator's ended
 * affiliate leaderboards, opened from the Overview card without navigating
 * away. Rows are serializable plain data passed from the server card (no
 * function props across the boundary). Prize is house cost → rose.
 */
export function PreviousLeaderboardsDialog({
  rows,
}: {
  rows: PreviousLeaderboardItem[];
}) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        <History className="mr-1 size-3.5" />
        Previous leaderboards
      </DialogTrigger>

      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-zinc-500/15 text-zinc-600 ring-1 ring-inset ring-zinc-500/30 dark:text-zinc-400">
              <History className="size-4" />
            </span>
            Previous leaderboards
          </DialogTitle>
          <DialogDescription>
            Ended affiliate leaderboards for this creator. Read-only — open one
            to review its standings and payout.
          </DialogDescription>
        </DialogHeader>

        {rows.length === 0 ? (
          <EmptyState
            icon={Trophy}
            title="No previous leaderboards"
            description="This creator has no ended leaderboards yet."
            compact
          />
        ) : (
          <div className="space-y-2">
            {rows.map((r) => (
              <Link
                key={r.id}
                href={`/creator-hub/leaderboards/${r.id}`}
                className="flex flex-col gap-2 rounded-md border p-3 transition-colors hover:bg-muted/50 sm:flex-row sm:items-center sm:justify-between sm:gap-3"
              >
                <div className="min-w-0 sm:flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="truncate text-sm font-medium">
                      {r.title}
                    </span>
                    {r.wageredRawUsd > 0 && (
                      <span className="shrink-0 text-xs tabular-nums text-emerald-600 dark:text-emerald-400">
                        · {formatCurrency(r.wageredRawUsd)} wagered ·{" "}
                        {formatCurrency(r.wageredWeightedUsd)} weighted
                      </span>
                    )}
                    {r.is_sponsored && (
                      <Badge variant="outline" className="text-[10px]">
                        sponsored
                      </Badge>
                    )}
                  </div>
                  <div className="mt-1 truncate text-xs text-muted-foreground">
                    {formatDate(r.start_date)} → {formatDate(r.end_date)}
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                    House paid {r.sponsoredPct}% ·{" "}
                    <span className="font-medium tabular-nums text-rose-600 dark:text-rose-400">
                      {formatCurrency(r.houseCostUsd)}
                    </span>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 sm:shrink-0">
                  <span className="text-sm font-semibold tabular-nums text-rose-600 dark:text-rose-400">
                    ${r.total_prize_usd}
                  </span>
                  <Badge
                    variant="outline"
                    className={cn(
                      "text-[10px]",
                      LEADERBOARD_APPROVAL_COLORS[r.approval_status],
                    )}
                  >
                    {r.approval_status}
                  </Badge>
                  <Badge
                    variant="outline"
                    className={cn(
                      "text-[10px]",
                      LEADERBOARD_TIME_COLORS[r.time_status],
                    )}
                  >
                    {r.time_status}
                  </Badge>
                </div>
              </Link>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
