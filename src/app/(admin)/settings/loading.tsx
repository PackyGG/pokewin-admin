import {
  PageTitleSkeleton,
  FormCardSkeleton,
} from "@/components/loading-skeletons";

export default function SettingsLoading() {
  return (
    <div className="space-y-6">
      <PageTitleSkeleton width={100} />
      <FormCardSkeleton rows={3} />
      <FormCardSkeleton rows={5} />
      <FormCardSkeleton rows={4} />
    </div>
  );
}
