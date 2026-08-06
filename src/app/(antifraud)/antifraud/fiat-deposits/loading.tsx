import { FiatDepositReviewsSkeleton } from "./review-queue-skeleton";

export default function FiatDepositReviewsLoading() {
  return (
    <div className="space-y-3">
      <FiatDepositReviewsSkeleton />
    </div>
  );
}
