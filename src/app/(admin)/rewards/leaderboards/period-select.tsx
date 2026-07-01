"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

type Period = { periodStart: string; participants: number };

// Human label for a period_start. Snapshots only store the start day, so the
// label is derived from race_type: a month name for monthly, a week-of for
// weekly, a plain date for daily.
function formatPeriodLabel(raceType: string, periodStart: string): string {
  const d = new Date(`${periodStart}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return periodStart;
  if (raceType === "monthly") {
    return d.toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });
  }
  const date = d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  return raceType === "weekly" ? `Week of ${date}` : date;
}

/**
 * Leaderboard picker for the Standings tab. The options ARE the real periods
 * that exist in the DB (race_leaderboard_snapshots) for the selected race type
 * — nothing is computed or guessed. Selecting one navigates to that
 * leaderboard; the participants come straight from its snapshot rows.
 */
export function PeriodSelect({
  raceType,
  periodStart,
  periods,
}: {
  raceType: string;
  periodStart?: string;
  periods: Period[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  if (periods.length === 0) {
    return (
      <span className="text-xs text-muted-foreground">
        No {raceType} leaderboards yet
      </span>
    );
  }

  return (
    <Select
      value={periodStart}
      onValueChange={(v) =>
        startTransition(() =>
          router.push(
            `/rewards?tab=leaderboards&lbtab=standings&raceType=${raceType}&periodStart=${v}`,
          ),
        )
      }
    >
      <SelectTrigger
        className={cn("h-8 w-[280px]", isPending && "opacity-60")}
        aria-busy={isPending || undefined}
      >
        <SelectValue placeholder="Select a leaderboard" />
      </SelectTrigger>
      <SelectContent>
        {periods.map((p) => (
          <SelectItem key={p.periodStart} value={p.periodStart}>
            {formatPeriodLabel(raceType, p.periodStart)}
            <span className="text-muted-foreground">
              {" "}
              · {p.participants} player{p.participants === 1 ? "" : "s"}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
