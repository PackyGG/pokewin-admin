import { CalendarClock } from "lucide-react";
import { PageHero } from "@/components/modern-panels";
import { Skeleton } from "@/components/ui/skeleton";
import { DAY_SHORT, SHIFTS_PER_DAY, SLOT_LABELS } from "./types";

export default function ShiftsLoading() {
  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
            <CalendarClock className="size-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold leading-tight">Shifts</h1>
            <p className="text-sm text-muted-foreground">
              Weekly support rota — three shift slots per day with flexible
              times. Hours are stored in UTC and rendered in your own
              timezone.
            </p>
          </div>
        </div>
      </PageHero>

      <div className="space-y-4">
        {/* Toolbar skeleton */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Skeleton className="h-9 w-64 rounded-md" />
          <div className="flex items-center gap-2">
            <Skeleton className="h-9 w-32 rounded-md" />
            <Skeleton className="h-9 w-24 rounded-md" />
          </div>
        </div>

        {/* Grid skeleton */}
        <div className="rounded-2xl border overflow-hidden">
          <div className="grid grid-cols-[80px_repeat(7,1fr)] border-b bg-muted/50">
            <div className="p-3" />
            {DAY_SHORT.map((d) => (
              <div key={d} className="p-3 text-xs font-semibold">
                {d}
              </div>
            ))}
          </div>
          {Array.from({ length: SHIFTS_PER_DAY }).map((_, slot) => (
            <div
              key={slot}
              className="grid grid-cols-[80px_repeat(7,1fr)] border-b last:border-b-0"
            >
              <div className="flex items-center justify-center p-3 text-xs font-medium text-muted-foreground">
                {SLOT_LABELS[slot]}
              </div>
              {Array.from({ length: 7 }).map((_, day) => (
                <div key={day} className="border-l p-2">
                  <Skeleton className="mb-2 h-3 w-20" />
                  <Skeleton className="h-5 w-16 rounded-full" />
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
