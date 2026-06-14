import type * as React from "react";
import Link from "next/link";
import {
  Lock,
  Pencil,
  Users,
  Crown,
  Headset,
  Megaphone,
  Sparkles,
  Package,
  UserCog,
  ArrowRight,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { StatPanel, PanelRow, type AccentColor } from "@/components/modern-panels";
import { formatDateTime } from "@/lib/utils/format";
import type { AdminRole } from "@/lib/admin-roles";
import { BuiltInRoleInspector } from "./built-in-role-inspector";
import type {
  BuiltInRoleSummary,
  CustomRoleSummary,
} from "./roles-overview-data";

// Per-role icon + accent for the grid. Static map — no DB, no function props.
const ROLE_VISUALS: Record<
  AdminRole,
  { icon: React.ElementType; accent: AccentColor }
> = {
  admin: { icon: Crown, accent: "amber" },
  support: { icon: Headset, accent: "blue" },
  marketing: { icon: Megaphone, accent: "purple" },
  creator: { icon: Sparkles, accent: "pink" },
  pack_creator: { icon: Package, accent: "cyan" },
  creator_manager: { icon: UserCog, accent: "emerald" },
};

/** A "Locked" pill for built-in roles. */
function LockedBadge() {
  return (
    <Badge
      variant="outline"
      className="gap-1 border-amber-500/30 bg-amber-500/10 text-[10px] font-medium text-amber-600 dark:text-amber-400"
    >
      <Lock className="size-3" />
      Locked
    </Badge>
  );
}

/** An "Editable" pill for custom roles. */
function EditableBadge() {
  return (
    <Badge
      variant="outline"
      className="gap-1 border-emerald-500/30 bg-emerald-500/10 text-[10px] font-medium text-emerald-600 dark:text-emerald-400"
    >
      <Pencil className="size-3" />
      Editable
    </Badge>
  );
}

/**
 * One built-in role card: token + holder counts, a Locked badge, and the
 * read-only baseline inspector trigger. No editable controls.
 */
function BuiltInRoleCard({ role }: { role: BuiltInRoleSummary }) {
  const visual = ROLE_VISUALS[role.role];
  return (
    <StatPanel
      title={role.label}
      icon={visual.icon}
      accent={visual.accent}
      action={<LockedBadge />}
    >
      <div className="space-y-0.5">
        {role.bypass ? (
          <PanelRow
            label="Access"
            value="Full (gate bypass)"
            valueClassName="text-emerald-600 dark:text-emerald-400"
          />
        ) : (
          <>
            <PanelRow label="Pages" value={role.pageCount} />
            <PanelRow label="Capabilities" value={role.capabilityCount} />
          </>
        )}
        <PanelRow
          label="Holders"
          value={
            <span className="inline-flex items-center gap-1">
              <Users className="size-3.5 text-muted-foreground" />
              {role.holderCount}
            </span>
          }
        />
      </div>
      <div className="mt-3">
        <BuiltInRoleInspector
          roleLabel={role.label}
          groups={role.groups}
          pageCount={role.pageCount}
          capabilityCount={role.capabilityCount}
          bypass={role.bypass}
          triggerClassName="w-full"
        />
      </div>
    </StatPanel>
  );
}

/**
 * One custom role card: token + holder counts, an Editable badge, and a link
 * into the existing custom-role editor (`/settings/roles/[id]`). Behavior of
 * that editor is unchanged.
 */
function CustomRoleCard({ role }: { role: CustomRoleSummary }) {
  return (
    <StatPanel
      title={role.name}
      icon={Pencil}
      accent="emerald"
      action={<EditableBadge />}
    >
      <div className="space-y-0.5">
        {role.description ? (
          <p className="mb-1 line-clamp-2 text-xs text-muted-foreground">
            {role.description}
          </p>
        ) : null}
        <PanelRow label="Permissions" value={role.tokenCount} />
        <PanelRow
          label="Holders"
          value={
            <span className="inline-flex items-center gap-1">
              <Users className="size-3.5 text-muted-foreground" />
              {role.holderCount}
            </span>
          }
        />
        <PanelRow label="Updated" value={formatDateTime(role.updatedAt)} />
      </div>
      <Link
        href={`/settings/roles/${role.id}`}
        className="mt-3 inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
      >
        <Pencil className="size-3.5" />
        Edit role
        <ArrowRight className="size-3.5" />
      </Link>
    </StatPanel>
  );
}

/** The locked built-in roles grid. */
export function BuiltInRolesGrid({ roles }: { roles: BuiltInRoleSummary[] }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {roles.map((role) => (
        <BuiltInRoleCard key={role.role} role={role} />
      ))}
    </div>
  );
}

/** The editable custom roles grid. */
export function CustomRolesGrid({ roles }: { roles: CustomRoleSummary[] }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {roles.map((role) => (
        <CustomRoleCard key={role.id} role={role} />
      ))}
    </div>
  );
}
