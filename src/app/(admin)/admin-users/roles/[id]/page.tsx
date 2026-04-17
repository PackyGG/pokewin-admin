import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireAdmin } from "@/lib/dal";
import { Badge } from "@/components/ui/badge";
import { getRole } from "../actions";
import { RoleEditor } from "../role-editor";

export const metadata = { title: "Role" };

export default async function RoleDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAdmin();
  const { id } = await params;
  const role = await getRole(id);
  if (!role) notFound();

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link
          href="/admin-users/roles"
          className="inline-flex size-9 items-center justify-center rounded-md hover:bg-accent hover:text-accent-foreground"
        >
          <ArrowLeft className="size-4" />
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold">{role.name}</h1>
            {role.is_system ? (
              <Badge
                variant="outline"
                className="bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30"
              >
                System
              </Badge>
            ) : (
              <Badge variant="outline">Custom</Badge>
            )}
          </div>
          {role.description && (
            <p className="text-sm text-muted-foreground">{role.description}</p>
          )}
        </div>
      </div>
      <RoleEditor role={role} />
    </div>
  );
}
