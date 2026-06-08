import Link from "next/link";
import { Trophy, Coins, Percent, Calendar, Clock, Hash } from "lucide-react";

import { cn } from "@/lib/utils";
import { formatCurrency, formatDate } from "@/lib/utils/format";

import {
  type LiveLeaderboardRow,
} from "../_queries/live-leaderboards";
import { LeaderboardTimeLeft } from "./leaderboard-time-left";

/**
 * Live Leaderboards ranklist — the ranked rows of currently-running creator
 * leaderboards. Server component (data passed in; no function props cross to
 * the client). The only client island is the per-row `LeaderboardTimeLeft`
 * ticker.
 *
 * House-POV colors (STRICT): a leaderboard's prize pool is money the house
 * pays out to players → the HOUSE COST is the headline rose figure. The full
 * pool is neutral context; the house % is the share we pay (rose). Creator /
 * dates / codes are neutral.
 *
 * Each row links into the Hub creator detail (`/creator-hub/creators/[id]`) and
 * the Hub leaderboard detail (`/creator-hub/leaderboards/[id]`).
 */

function rankBadgeTint(i: number): string {
  // Podium tints for the top 3; muted for the rest (decorative only — NOT a
  // house-POV signal).
  if (i === 0) return "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30";
  if (i === 1) return "bg-zinc-400/15 text-zinc-700 dark:text-zinc-300 border-zinc-400/30";
  if (i === 2) return "bg-orange-500/15 text-orange-700 dark:text-orange-300 border-orange-500/30";
  return "bg-muted text-muted-foreground border-border";
}

function LiveLeaderboardCard({
  row,
  index,
}: {
  row: LiveLeaderboardRow;
  index: number;
}) {
  const isActive = row.lifecycle === "active";
  const creatorLabel = row.creatorUsername ?? `id ${row.creatorUserId.slice(0, 8)}…`;

  return (
    <li className="hover-raise surface-sheen relative overflow-hidden rounded-xl border bg-card/60 p-3 transition-colors hover:bg-accent/30 sm:p-4">
      <div className="flex items-start gap-3">
        {/* Rank chip */}
        <span
          className={cn(
            "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg border text-xs font-bold tabular-nums",
            rankBadgeTint(index),
          )}
          aria-label={`Rank ${index + 1}`}
        >
          {index + 1}
        </span>

        {/* Identity: title + creator + codes */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={`/creator-hub/leaderboards/${row.id}`}
              className="truncate text-sm font-semibold outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              {row.title}
            </Link>
            {/* Status pill: active = live (emerald dot + neutral text);
                upcoming = blue. Status is operational, not a money signal. */}
            {isActive ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-300">
                <span className="relative flex size-1.5">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75 motion-reduce:hidden" />
                  <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
                </span>
                Live
              </span>
            ) : (
              <span className="inline-flex items-center rounded-full border border-blue-500/30 bg-blue-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-blue-700 dark:text-blue-300">
                Upcoming
              </span>
            )}
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <Link
              href={`/creator-hub/creators/${row.creatorUserId}`}
              className="inline-flex max-w-[180px] items-center gap-1 truncate font-medium text-foreground/80 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Trophy className="size-3 shrink-0 text-amber-500" />
              <span className="truncate">{creatorLabel}</span>
            </Link>
            {row.affiliateCodes.length > 0 && (
              <span className="inline-flex items-center gap-1">
                <Hash className="size-3 shrink-0" />
                <span className="truncate font-mono">
                  {row.affiliateCodes.slice(0, 2).join(", ")}
                  {row.affiliateCodes.length > 2 &&
                    ` +${row.affiliateCodes.length - 2}`}
                </span>
              </span>
            )}
            <span className="inline-flex items-center gap-1">
              <Calendar className="size-3 shrink-0" />
              {formatDate(row.startIso)} → {formatDate(row.endIso)}
            </span>
            <span className="inline-flex items-center gap-1">
              <Clock className="size-3 shrink-0" />
              <LeaderboardTimeLeft
                edgeIso={isActive ? row.endIso : row.startIso}
                initialMs={row.msUntilEdge}
                ended={isActive}
              />
              <span>{isActive ? "left" : "to start"}</span>
            </span>
          </div>
        </div>

        {/* Money block — house cost is the rose headline (house-POV). Pool +
            house % are the neutral/rose context. */}
        <div className="grid shrink-0 grid-cols-3 gap-3 text-right">
          <div>
            <p className="text-sm font-bold tabular-nums text-rose-600 dark:text-rose-400">
              {formatCurrency(row.houseCostUsd)}
            </p>
            <p className="flex items-center justify-end gap-1 text-[10px] text-muted-foreground">
              <Coins className="size-3" /> house cost
            </p>
          </div>
          <div className="hidden sm:block">
            <p className="text-sm font-semibold tabular-nums text-foreground">
              {formatCurrency(row.prizeUsd)}
            </p>
            <p className="text-[10px] text-muted-foreground">prize pool</p>
          </div>
          <div className="hidden sm:block">
            <p className="text-sm font-semibold tabular-nums text-rose-600/90 dark:text-rose-400/90">
              {row.housePct.toFixed(0)}%
            </p>
            <p className="flex items-center justify-end gap-1 text-[10px] text-muted-foreground">
              <Percent className="size-3" /> house share
            </p>
          </div>
        </div>
      </div>
    </li>
  );
}

export function LiveLeaderboardsRanklist({
  active,
  upcoming,
  backendUnavailable,
}: {
  active: LiveLeaderboardRow[];
  upcoming: LiveLeaderboardRow[];
  backendUnavailable: boolean;
}) {
  if (backendUnavailable) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed py-12 text-center">
        <Trophy className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">Leaderboards backend unavailable</p>
        <p className="text-xs text-muted-foreground">
          The approved-leaderboard list couldn&apos;t be loaded. Try again shortly.
        </p>
      </div>
    );
  }

  if (active.length === 0 && upcoming.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed py-12 text-center">
        <Trophy className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">No running leaderboards</p>
        <p className="text-xs text-muted-foreground">
          Active and upcoming creator leaderboards will rank here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Active (ranked) */}
      {active.length > 0 ? (
        <ul className="space-y-2.5">
          {active.map((row, i) => (
            <LiveLeaderboardCard key={row.id} row={row} index={i} />
          ))}
        </ul>
      ) : (
        <div className="rounded-xl border border-dashed py-8 text-center text-sm text-muted-foreground">
          No leaderboards are running right now.
        </div>
      )}

      {/* Upcoming (context, soonest-first) */}
      {upcoming.length > 0 && (
        <div className="space-y-2.5">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Upcoming ({upcoming.length})
          </p>
          <ul className="space-y-2.5">
            {upcoming.map((row, i) => (
              <LiveLeaderboardCard key={row.id} row={row} index={i} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
