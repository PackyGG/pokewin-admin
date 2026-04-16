import {
  PageTitleSkeleton,
  ToolbarSkeleton,
  CardGridSkeleton,
} from "@/components/loading-skeletons";

export default function CardsLoading() {
  return (
    <div className="space-y-4">
      <PageTitleSkeleton width={100} />
      <ToolbarSkeleton />
      <CardGridSkeleton count={12} aspect="3/4" />
    </div>
  );
}
