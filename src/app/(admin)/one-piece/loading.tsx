import { Anchor, Activity, Package } from "lucide-react";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import {
  KpiStripSkeleton,
  TableSkeleton,
  ChartSkeleton,
} from "@/components/loading-skeletons";

export default function Loading() {
  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Anchor}
          accent="amber"
          title="One Piece"
          subtitle="The One Piece pack pool: lifetime economics, per-pack insights and a 30-day opens & revenue trend."
        />
      </PageHero>

      <KpiStripSkeleton count={5} />

      <div>
        <SectionHeading icon={Activity} title="Daily opens & revenue (30d)" />
        <div className="mt-3">
          <ChartSkeleton height={320} />
        </div>
      </div>

      <div>
        <SectionHeading icon={Package} title="All One Piece packs" />
        <div className="mt-3">
          <TableSkeleton rows={6} columns={6} />
        </div>
      </div>
    </div>
  );
}
