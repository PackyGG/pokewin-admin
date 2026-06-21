import {
  PageHeroSkeleton,
  SectionHeadingSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";

/**
 * Route-level loading skeleton for Pack Doctor. Mirrors the page shell — hero,
 * a "Scored packs" section heading (with a filter-bar action placeholder), and
 * the scored grid — so the first paint matches the eventual layout while the
 * server component resolves access + reads.
 */
export default function PackDoctorLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={110} action />
        <TableSkeleton rows={8} columns={10} />
      </div>
    </div>
  );
}
