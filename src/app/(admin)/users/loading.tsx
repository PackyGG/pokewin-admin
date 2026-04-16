import {
  PageTitleSkeleton,
  ToolbarSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";

// Matches /users: title, filter toolbar, paginated users table with
// profile pictures. Row count matches the default perPage of 20.
export default function UsersLoading() {
  return (
    <div className="space-y-4">
      <PageTitleSkeleton width={100} />
      <ToolbarSkeleton />
      <TableSkeleton rows={15} />
    </div>
  );
}
