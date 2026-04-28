import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Lock, ShieldCheck, Users, KeyRound } from "lucide-react";
import { requireAdmin } from "@/lib/dal";
import { Badge } from "@/components/ui/badge";
import { PageHero, KpiTile } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
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
    <div className="space-y-6">
      <PageHero>
        <div className="flex items-center gap-3">
          <Link
            href="/admin-users/roles"
            className="inline-flex size-9 items-center justify-center rounded-md hover:bg-accent hover:text-accent-foreground"
          >
            <ArrowLeft className="size-4" />
          </Link>
          <div className="flex size-10 items-center justify-center rounded-xl bg-amber-500/10">
            <Lock className="size-5 text-amber-500" />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold leading-tight">{role.name}</h1>
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
      </PageHero>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <KpiTile
          label="Type"
          value={role.is_system ? "System" : "Custom"}
          icon={role.is_system ? Lock : KeyRound}
          accent={role.is_system ? "blue" : "purple"}
        />
        <KpiTile
          label="Capabilities"
          value={String(role.capabilities.length)}
          icon={ShieldCheck}
          accent="amber"
        />
        <KpiTile
          label="Assigned Admins"
          value={String(role.user_count)}
          icon={Users}
          accent="cyan"
        />
      </div>

      <FadeIn>
        <RoleEditor role={role} />
      </FadeIn>
    </div>
  );
}
