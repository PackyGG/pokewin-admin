import { Lightbulb } from "lucide-react";
import { PageHero } from "@/components/modern-panels";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Loading shell for the ideas canvas. Mirrors the real page layout
 * (hero → toolbar → canvas) so the swap to loaded content is
 * near-seamless. The canvas skeleton is a dot-grid surface with a
 * cluster of placeholder cards at the top-left — same position where
 * newly-created cards land, which is where the real content usually
 * renders too.
 */
export default function IdeasLoading() {
  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
            <Lightbulb className="size-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold leading-tight">Ideas</h1>
            <p className="text-sm text-muted-foreground">
              Internal idea board — drag to reorder, click the chip to cycle
              neutral → go → kill.
            </p>
          </div>
        </div>
      </PageHero>

      <div className="space-y-3">
        {/* Toolbar skeleton */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Skeleton className="h-4 w-40" />
          <div className="flex items-center gap-2">
            <Skeleton className="h-9 w-28 rounded-md" />
            <Skeleton className="h-9 w-28 rounded-md" />
          </div>
        </div>

        {/* Canvas skeleton — dot grid + 6 placeholder cards at the
            top-left where the real board's first cluster typically
            sits. */}
        <div
          className="relative h-[75vh] min-h-[560px] overflow-hidden rounded-2xl border bg-background [background-image:radial-gradient(circle,var(--muted-foreground)_0.6px,transparent_0.6px)] [background-size:24px_24px]"
        >
          <div className="grid grid-cols-2 gap-3 p-8 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {Array.from({ length: 10 }).map((_, i) => (
              <IdeaCardSkeleton key={i} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * One placeholder card matching the rendered card dimensions (260×160)
 * + the same internal layout (title line + description lines + status
 * chip + author).
 */
function IdeaCardSkeleton() {
  return (
    <div className="flex h-[160px] w-[260px] flex-col gap-2 rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <Skeleton className="h-4 flex-1" />
        <Skeleton className="size-4 shrink-0" />
      </div>
      <div className="space-y-1.5">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-3/4" />
        <Skeleton className="h-3 w-1/2" />
      </div>
      <div className="mt-auto flex items-center justify-between">
        <Skeleton className="h-6 w-16 rounded-full" />
        <Skeleton className="h-3 w-12" />
      </div>
    </div>
  );
}
