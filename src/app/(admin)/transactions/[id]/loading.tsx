import {
  DetailHeaderSkeleton,
  FormCardSkeleton,
} from "@/components/loading-skeletons";

export default function TransactionDetailLoading() {
  return (
    <div className="space-y-6">
      <DetailHeaderSkeleton />
      <FormCardSkeleton rows={6} />
      <FormCardSkeleton rows={4} />
    </div>
  );
}
