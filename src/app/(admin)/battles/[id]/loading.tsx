import { Skeleton } from "@/components/ui/skeleton";
import {
  DetailHeroSkeleton,
  KpiStripSkeleton,
  SectionHeadingSkeleton,
} from "@/components/loading-skeletons";

/**
 * Matches /battles/[id]: detail hero with status/mode badges + cancel
 * button (only if waiting), conditional 5-tile KPI strip (only on
 * completed battles), and a Details section. Teams render below in a
 * separate section in real life — represented here as a single placeholder
 * card row to keep the skeleton compact when the battle isn't yet
 * completed (no KPI strip).
 */
export default function BattleDetailLoading() {
  return (
    <div className="space-y-6">
      <DetailHeroSkeleton action />
      <KpiStripSkeleton count={5} />
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={80} />
        <Skeleton className="h-64 rounded-2xl" />
      </div>
    </div>
  );
}
