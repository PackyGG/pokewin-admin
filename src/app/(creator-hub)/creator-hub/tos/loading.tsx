import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading skeleton for /creator-hub/tos.
 *
 * Without this the segment fell back to the Creator Hub root `loading.tsx`
 * (`HubDashboardSkeleton`) — a completely different shape — so a cold nav
 * flashed the dashboard layout and then snapped to this page. Mirrors the
 * real chrome: section heading, the editor card, then the published-versions
 * card. Same shape as the page's own <Suspense> fallback.
 */
export default function CreatorTermsLoading() {
  return (
    <div className="space-y-6">
      {/* SectionHeading — icon chip + title. */}
      <div className="flex items-center gap-2">
        <Skeleton className="size-8 rounded-lg" />
        <Skeleton className="h-5 w-56 rounded" />
      </div>

      {/* Terms editor card. */}
      <Card className="space-y-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="space-y-2">
            <Skeleton className="h-5 w-72 rounded" />
            <Skeleton className="h-4 w-96 max-w-full rounded" />
          </div>
          <Skeleton className="h-6 w-24 rounded-md" />
        </div>
        <Skeleton className="h-56 w-full rounded-lg" />
      </Card>

      {/* Published versions card. */}
      <Card className="overflow-hidden">
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <Skeleton className="size-4 rounded" />
          <Skeleton className="h-5 w-40 rounded" />
        </div>
        <div className="divide-y">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
            >
              <Skeleton className="h-4 w-48 rounded" />
              <div className="space-y-1.5 text-right">
                <Skeleton className="ml-auto h-3 w-32 rounded" />
                <Skeleton className="ml-auto h-3 w-24 rounded" />
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
