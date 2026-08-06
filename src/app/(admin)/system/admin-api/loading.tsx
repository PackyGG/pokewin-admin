import {
  PageHeroSkeleton,
  SectionHeadingSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";

/**
 * Route-level loading skeleton for /system/admin-api.
 *
 * Without it the segment inherited the generic (admin) shell — hero + KPI
 * strip + charts — while the real page is a hero followed by the API-key
 * table. This matches the page's own <Suspense> fallback exactly (section
 * heading + 5×5 table) so a cold navigation and the streaming state look the
 * same. The static Endpoints catalogue below the table needs no DB read, so
 * it is not part of the loading shape.
 */
export default function AdminApiLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <div className="space-y-4">
        <SectionHeadingSkeleton titleWidth={140} />
        <TableSkeleton rows={5} columns={5} />
      </div>
    </div>
  );
}
