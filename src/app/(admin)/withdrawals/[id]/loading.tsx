import {
  DetailHeaderSkeleton,
  FormCardSkeleton,
} from "@/components/loading-skeletons";

export default function WithdrawalDetailLoading() {
  return (
    <div className="space-y-6">
      <DetailHeaderSkeleton />
      <FormCardSkeleton rows={5} />
      <FormCardSkeleton rows={4} />
    </div>
  );
}
