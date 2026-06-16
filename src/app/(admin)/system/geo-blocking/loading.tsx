import {
  PageHeroSkeleton,
  SectionHeadingSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /system/geo-blocking: hero, the "Geo Blocking" section heading,
 * and the 9-column per-country restrictions table (Country + the toggle /
 * locked-currency columns). Keeps the shell painted immediately while the
 * server read resolves so navigation is shift-free instead of blank.
 */
export default function GeoBlockingLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={120} />
        <TableSkeleton rows={10} columns={9} />
      </div>
    </div>
  );
}
