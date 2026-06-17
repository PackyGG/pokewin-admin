import { Suspense } from "react";
import { CalendarRange } from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { Skeleton } from "@/components/ui/skeleton";
import { getRoadmapItems } from "./queries";
import { RoadmapCalendar } from "./roadmap-calendar";

export const metadata = { title: "Roadmap" };

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function CalendarSkeleton() {
  return (
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
                {d % 3 === 0 && <Skeleton className="h-5 w-full rounded-md" />}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

async function RoadmapData() {
  const items = await getRoadmapItems();
  return <RoadmapCalendar items={items} />;
}

export default async function RoadmapPage() {
  await requirePageAccess("/roadmap");

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={CalendarRange}
          title="Roadmap"
          subtitle="Plan upcoming features on a calendar. Click a block to open its product page."
        />
      </PageHero>

      <Suspense fallback={<CalendarSkeleton />}>
        <RoadmapData />
      </Suspense>
    </div>
  );
}
