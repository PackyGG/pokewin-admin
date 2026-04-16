import {
  PageTitleSkeleton,
  FormCardSkeleton,
} from "@/components/loading-skeletons";

export default function RewardsSettingsLoading() {
  return (
    <div className="space-y-6">
      <PageTitleSkeleton width={160} />
      <FormCardSkeleton rows={4} />
      <FormCardSkeleton rows={3} />
    </div>
  );
}
