import { PageHeroSkeleton } from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/** Matches /staff/quizzes: hero, section heading, a grid of quiz cards. */
export default function QuizzesLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <div className="space-y-4">
        <div className="flex items-center gap-2.5">
          <Skeleton className="size-7 rounded-lg" />
          <Skeleton className="h-4 w-36" />
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-32 w-full rounded-xl" />
          ))}
        </div>
      </div>
    </div>
  );
}
