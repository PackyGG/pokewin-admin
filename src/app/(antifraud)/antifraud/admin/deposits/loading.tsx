import {
  DeclinedDepositsCountSkeleton,
  DeclinedDepositsHeader,
  DeclinedDepositsSkeleton,
} from "./declined-deposits-skeleton";

export default function Loading() {
  return (
    <div className="space-y-4">
      <DeclinedDepositsHeader count={<DeclinedDepositsCountSkeleton />} />
      <DeclinedDepositsSkeleton />
    </div>
  );
}
