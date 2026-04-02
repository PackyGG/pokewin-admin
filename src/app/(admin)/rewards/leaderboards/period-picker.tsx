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

  function shift(days: number) {
    const d = new Date(periodStart);
    d.setDate(d.getDate() + days);
    navigate(d.toISOString().slice(0, 10));
  }

  const step = raceType === "weekly" ? 7 : 1;

  return (
    <div className="flex items-center gap-1">
      <Button variant="outline" size="icon" className="size-8" onClick={() => shift(-step)}>
        <ChevronLeft className="size-4" />
      </Button>
      <Input
        type="date"
        value={periodStart}
        onChange={(e) => e.target.value && navigate(e.target.value)}
        className="h-8 w-40"
      />
      <Button variant="outline" size="icon" className="size-8" onClick={() => shift(step)}>
        <ChevronRight className="size-4" />
      </Button>
    </div>
  );
}
