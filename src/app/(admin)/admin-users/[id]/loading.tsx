import {
  DetailHeaderSkeleton,
  FormCardSkeleton,
} from "@/components/loading-skeletons";

export default function AdminUserDetailLoading() {
  return (
    <div className="space-y-6">
      <DetailHeaderSkeleton />
      <FormCardSkeleton rows={4} />
      <FormCardSkeleton rows={3} />
    </div>
  );
}
