import {
  DetailHeaderSkeleton,
  StatCardRowSkeleton,
  CardGridSkeleton,
} from "@/components/loading-skeletons";

export default function PackDetailLoading() {
  return (
    <div className="space-y-6">
      <DetailHeaderSkeleton />
      <StatCardRowSkeleton count={3} height={100} />
      <CardGridSkeleton count={12} aspect="3/4" />
    </div>
  );
}
