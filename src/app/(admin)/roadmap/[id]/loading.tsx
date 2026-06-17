import { Rocket } from "lucide-react";
import { PageHero } from "@/components/modern-panels";
import { Skeleton } from "@/components/ui/skeleton";

export default function RoadmapItemLoading() {
  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
            <Rocket className="size-5 text-primary" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-6 w-56 rounded-md" />
            <Skeleton className="h-4 w-72 rounded-md" />
          </div>
        </div>
      </PageHero>

      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="space-y-3">
          <Skeleton className="h-5 w-32 rounded-md" />
          <div className="rounded-2xl border bg-card p-4">
            <Skeleton className="mb-2 h-4 w-full rounded-md" />
            <Skeleton className="h-4 w-2/3 rounded-md" />
          </div>
        </div>
      ))}
    </div>
  );
}
