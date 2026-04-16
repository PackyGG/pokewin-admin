import { Skeleton } from "@/components/ui/skeleton";
import { PageTitleSkeleton } from "@/components/loading-skeletons";

// Chat is a live feed with pinned + recent messages — skeleton mirrors
// that with a small stack of message-row blocks.
export default function ChatLoading() {
  return (
    <div className="space-y-4">
      <PageTitleSkeleton width={100} />
      <Skeleton className="h-24 rounded-xl" />
      <div className="rounded-xl border">
        {Array.from({ length: 15 }).map((_, i) => (
          <div key={i} className="flex items-start gap-3 border-b p-3 last:border-0">
            <Skeleton className="size-8 shrink-0 rounded-full" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-4 w-full max-w-xl" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
