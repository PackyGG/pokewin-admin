import { PageHero, PageHeroIdentity } from "@/components/modern-panels";

import { WithdrawalReviewSkeleton } from "./review-skeleton";

export default function WithdrawalReviewLoading() {
  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity backHref="/antifraud/withdrawals" />
      </PageHero>
      <WithdrawalReviewSkeleton />
    </div>
  );
}
