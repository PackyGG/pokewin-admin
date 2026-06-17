import { CalendarRange } from "lucide-react";
import { PageHero } from "@/components/modern-panels";
import { Skeleton } from "@/components/ui/skeleton";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export default function RoadmapLoading() {
  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
            <CalendarRange className="size-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold leading-tight">Roadmap</h1>
            <p className="text-sm text-muted-foreground">
              Plan upcoming features on a calendar. Click a block to open its
              product page.
            </p>
          </div>
        </div>
      </PageHero>

      <div className="space-y-4">
        {/* Toolbar skeleton */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Skeleton className="h-9 w-9 rounded-md" />
            <Skeleton className="h-9 w-40 rounded-md" />
            <Skeleton className="h-9 w-9 rounded-md" />
            <Skeleton className="h-9 w-20 rounded-md" />
          </div>
          <Skeleton className="h-9 w-32 rounded-md" />
        </div>

        {/* Month grid skeleton */}
        <div className="overflow-hidden rounded-2xl border bg-card shadow-sm">
          <div className="grid grid-cols-7 border-b bg-muted/30">
            {WEEKDAYS.map((d) => (
              <div
                key={d}
                className="p-2 text-center text-xs font-semibold text-muted-foreground"
              >
                {d}
              </div>
            ))}
          </div>
          {Array.from({ length: 5 }).map((_, w) => (
            <div key={w} className="grid grid-cols-7 border-b last:border-b-0">
              {Array.from({ length: 7 }).map((_, d) => (
                <div
                  key={d}
                  className="min-h-[92px] border-l p-2 first:border-l-0"
                >
                  <Skeleton className="mb-2 ml-auto h-4 w-5 rounded" />
                  {(w + d) % 4 === 0 && (
                    <Skeleton className="h-5 w-full rounded-md" />
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
