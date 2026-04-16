import { Skeleton } from "@/components/ui/skeleton";
import { PageTitleSkeleton } from "@/components/loading-skeletons";

// Trello is a 3-column kanban board — skeleton mirrors three stacks
// of card blocks so the transition to real content is seamless.
export default function TrelloLoading() {
  return (
    <div className="space-y-4">
      <PageTitleSkeleton width={100} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {Array.from({ length: 3 }).map((_, col) => (
          <div key={col} className="space-y-2">
            <Skeleton className="h-6 w-32" />
            {Array.from({ length: 4 }).map((__, i) => (
              <Skeleton key={i} className="h-20 rounded-md" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
