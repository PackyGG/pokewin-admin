"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { transition } from "@/components/ux";

export function PeriodPicker({
  raceType,
  periodStart,
}: {
  raceType: string;
  periodStart: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function navigate(date: string) {
    // Wrap in a transition so the picker can show a pending cue the instant
    // the admin steps the period, before the keyed Suspense swaps the table
    // skeleton in. Same destination + behavior, just immediate feedback.
    startTransition(() => {
      router.push(
        `/rewards/leaderboards?raceType=${raceType}&periodStart=${date}`,
      );
    });
  }

  function shift(direction: -1 | 1) {
    const d = new Date(periodStart);
    if (raceType === "monthly") {
      // Calendar-month step. Snapshots are dated by the period's start day so
      // shifting by ±30 days could land off the calendar grid; using
      // setUTCMonth keeps us anchored to actual month boundaries.
      d.setUTCMonth(d.getUTCMonth() + direction);
    } else if (raceType === "weekly") {
      d.setUTCDate(d.getUTCDate() + direction * 7);
    } else {
      d.setUTCDate(d.getUTCDate() + direction);
    }
    navigate(d.toISOString().slice(0, 10));
  }

  return (
    <div
      className={cn(
        "flex items-center gap-1",
        transition("opacity", "fast"),
        isPending && "opacity-60",
      )}
      aria-busy={isPending || undefined}
    >
      <Button
        variant="outline"
        size="icon"
        className="size-8"
        onClick={() => shift(-1)}
        disabled={isPending}
      >
        <ChevronLeft className="size-4" />
      </Button>
      <Input
        type="date"
        value={periodStart}
        onChange={(e) => e.target.value && navigate(e.target.value)}
        className="h-8 w-40"
        disabled={isPending}
      />
      <Button
        variant="outline"
        size="icon"
        className="size-8"
        onClick={() => shift(1)}
        disabled={isPending}
      >
        <ChevronRight className="size-4" />
      </Button>
    </div>
  );
}
