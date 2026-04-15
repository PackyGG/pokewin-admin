import { Suspense } from "react";
import { getUsers } from "@/lib/queries/users";
import { requirePageAccess } from "@/lib/dal";
import { UsersDataTable } from "./data-table";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { Skeleton } from "@/components/ui/skeleton";

export const metadata = { title: "Users" };

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/users");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;

  const result = await getUsers({
    page,
    perPage,
    search: params.search,
    role: params.role,
    status: params.status,
    sortBy: params.sortBy,
    sortOrder: params.sortOrder,
  });

  return (
    <div className="space-y-4">
      <h1 className="text-page-title">Users</h1>
      <Suspense fallback={<Skeleton className="h-10 w-full" />}>
        <DataTableToolbar
          searchPlaceholder="Search by username, email, or ID..."
          filters={[
            {
              name: "Role",
              paramKey: "role",
              options: [
                { label: "Admin", value: "admin" },
                { label: "Support", value: "support" },
                { label: "Creator", value: "creator" },
                { label: "User", value: "user" },
              ],
            },
            {
              name: "Status",
              paramKey: "status",
              options: [
                { label: "Active", value: "active" },
                { label: "Banned", value: "banned" },
                { label: "Locked", value: "locked" },
              ],
            },
          ]}
        />
      </Suspense>
      <UsersDataTable data={result.data} />
      <DataTablePagination
        page={result.page}
        totalPages={result.totalPages}
        total={result.total}
        perPage={result.perPage}
      />
    </div>
  );
}
