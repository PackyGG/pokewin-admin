import {
  PageTitleSkeleton,
  FormCardSkeleton,
} from "@/components/loading-skeletons";

export default function CreatorSettingsLoading() {
  return (
    <div className="space-y-6">
      <PageTitleSkeleton width={160} />
      <FormCardSkeleton rows={2} />
      <FormCardSkeleton rows={5} />
    </div>
  );
}
