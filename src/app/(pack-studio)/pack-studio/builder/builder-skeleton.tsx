import {
  FormCardSkeleton,
  KpiStripSkeleton,
} from "@/components/loading-skeletons";

/** Shell-matching fallback shared by the page Suspense boundary and loading.tsx. */
export function BuilderSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <div className="lg:col-span-2">
        <FormCardSkeleton rows={6} />
      </div>
      <div className="space-y-4">
        <KpiStripSkeleton count={4} />
        <FormCardSkeleton rows={3} />
      </div>
    </div>
  );
}
