import { SectionHeadingSkeleton } from "@/components/loading-skeletons";

import { FinancesOverviewSkeleton } from "./skeleton";

export default function Loading() {
  return (
    <div className="space-y-6">
      <SectionHeadingSkeleton action titleWidth={170} />
      <FinancesOverviewSkeleton />
    </div>
  );
}
