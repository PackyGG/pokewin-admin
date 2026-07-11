import {
  PageHeroSkeleton,
  SectionHeadingSkeleton,
} from "@/components/loading-skeletons";
import { SkeletonTable } from "@/components/ux";

/**
 * Matches /vips: hero, "VIP accounts" section heading, VIP-user table
 * (Username / Email / Lifetime PnL / Deposits / Withdrawals / Country /
 * Tagged at — 7 columns). Shape mirrors page.tsx 1:1 so the real content
 * swaps in without layout jump.
 */
export default function VipsLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={140} />
        <SkeletonTable rows={8} columns={7} rowHeight={44} />
      </div>
    </div>
  );
}
