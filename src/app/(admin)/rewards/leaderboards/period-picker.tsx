"use client";

import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function PeriodPicker({
  raceType,
  periodStart,
}: {
  raceType: string;
  periodStart: string;
}) {
  const router = useRouter();

  function navigate(date: string) {
    router.push(`/rewards/leaderboards?raceType=${raceType}&periodStart=${date}`);
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
    <div className="flex items-center gap-1">
      <Button variant="outline" size="icon" className="size-8" onClick={() => shift(-1)}>
        <ChevronLeft className="size-4" />
      </Button>
      <Input
        type="date"
        value={periodStart}
        onChange={(e) => e.target.value && navigate(e.target.value)}
        className="h-8 w-40"
      />
      <Button variant="outline" size="icon" className="size-8" onClick={() => shift(1)}>
        <ChevronRight className="size-4" />
      </Button>
    </div>
  );
}
