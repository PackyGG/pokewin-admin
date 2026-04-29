import { Skeleton } from "@/components/ui/skeleton";
import {
  PageHeroSkeleton,
  KpiStripSkeleton,
  TabBarSkeleton,
  SectionHeadingSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /my-profile (creator self-view): hero with badges, 8 KPI tiles
 * in a 4-up grid (rendered here as two 4-tile rows), SocialsCard,
 * 4-tab bar (Webhooks / Referrals / Payouts / Deals), default Webhooks
 * tab content (a card with the webhooks list).
 */
export default function MyProfileLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <KpiStripSkeleton count={4} />
      <KpiStripSkeleton count={4} />
      <Skeleton className="h-48 rounded-2xl" />
      <div className="space-y-3">
        <TabBarSkeleton count={4} />
        <SectionHeadingSkeleton titleWidth={120} />
        <TableSkeleton rows={6} columns={5} />
      </div>
    </div>
  );
}
