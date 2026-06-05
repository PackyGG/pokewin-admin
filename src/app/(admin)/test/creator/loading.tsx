import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading skeleton for /test/creator — keeps the shell visible
 * on a cold navigation while the page resolves (it gates on the dev-env
 * cookie and redirects to /dashboard otherwise, so this is a brief flash).
 *
 * This page is NOT a modern PageHero page — it's a plain `flex flex-col
 * gap-4` with an intro card (title + description + bullet list) and the
 * testing-tools card (a "Tools" header + a 5-tab strip + tab content). The
 * skeleton matches that exact two-card shape so there's no layout jump
 * when the real content swaps in.
 */
export default function CreatorTestingLoading() {
  return (
    <div className="flex flex-col gap-4">
      {/* Intro card — title + description + bullet list. */}
      <div className="rounded-xl border bg-card p-6">
        <Skeleton className="h-5 w-48 rounded" />
        <Skeleton className="mt-2 h-3 w-full max-w-xl rounded" />
        <Skeleton className="mt-1.5 h-3 w-4/5 max-w-xl rounded" />
        <div className="mt-4 space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-3 w-3/4 rounded" />
          ))}
        </div>
      </div>

      {/* Tools card — header + 5-tab strip + tab content. */}
      <div className="rounded-xl border bg-card p-6">
        <Skeleton className="h-4 w-16 rounded" />
        <div className="mt-4 grid w-full max-w-3xl grid-cols-5 gap-1 rounded-md bg-muted p-1">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-8 rounded-sm" />
          ))}
        </div>
        <div className="mt-4 space-y-3">
          <Skeleton className="h-9 w-full rounded-md" />
          <Skeleton className="h-9 w-2/3 rounded-md" />
          <Skeleton className="h-32 w-full rounded-lg" />
        </div>
      </div>
    </div>
  );
}
