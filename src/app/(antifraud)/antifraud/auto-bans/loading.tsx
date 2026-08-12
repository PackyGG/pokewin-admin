import {
  AutoBansKpiSkeleton,
  AutoBansListSkeleton,
  AutoBansSearchSkeleton,
} from "./auto-bans-skeleton";

export default function AutoBansLoading() {
  return (
    <div className="space-y-4">
      <AutoBansKpiSkeleton />
      <AutoBansSearchSkeleton />
      <AutoBansListSkeleton />
    </div>
  );
}
