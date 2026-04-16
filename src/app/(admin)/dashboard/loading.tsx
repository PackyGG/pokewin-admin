import {
  PageTitleSkeleton,
  StatCardRowSkeleton,
  ChartRowSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";

// Matches /dashboard layout: title, 4 primary stats, 4 secondary stats,
// 3 charts (Wagers / Deposits / Signups), recent activity table.
export default function DashboardLoading() {
  return (
    <div className="space-y-6">
      <PageTitleSkeleton width={140} />
      <StatCardRowSkeleton count={4} />
      <StatCardRowSkeleton count={4} />
      <ChartRowSkeleton count={3} />
      <TableSkeleton rows={8} />
    </div>
  );
}
