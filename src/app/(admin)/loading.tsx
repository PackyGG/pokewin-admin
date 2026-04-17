import {
  PageHeroSkeleton,
  KpiStripSkeleton,
  ChartRowSkeleton,
} from "@/components/loading-skeletons";

/**
 * Root fallback — used when Next doesn't find a closer loading.tsx. Keep
 * it generic but modern so it at least matches the hero + tiles layout
 * every admin page uses.
 */
export default function AdminLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <KpiStripSkeleton count={4} />
      <ChartRowSkeleton count={2} height={260} />
    </div>
  );
}
