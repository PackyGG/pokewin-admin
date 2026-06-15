import type * as React from "react";
import Link from "next/link";
import {
  Users,
  Crown,
  Headset,
  Megaphone,
  Sparkles,
  Package,
  UserCog,
  ArrowRight,
  ShieldCheck,
  KeyRound,
  Compass,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  StatPanel,
  PanelRow,
  type AccentColor,
} from "@/components/modern-panels";
import { formatDateTime } from "@/lib/utils/format";
import type { AdminRole } from "@/lib/admin-roles";
import type { RoleSummary } from "./roles-overview-data";
import { RoleCardActions } from "./role-card-actions";

// Per-identity icon + accent. The 6 system roles get their distinct identity;
// custom roles share the KeyRound/emerald look. Static map — no DB, no function
// props across the RSC boundary.
const SYSTEM_VISUALS: Record<
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

const CUSTOM_VISUAL: { icon: React.ElementType; accent: AccentColor } = {
  icon: KeyRound,
  accent: "emerald",
};

function roleVisual(role: RoleSummary): {
  icon: React.ElementType;
  accent: AccentColor;
} {
  if (role.systemKey) return SYSTEM_VISUALS[role.systemKey];
  return CUSTOM_VISUAL;
}

/** A small muted "System" pill for the 6 enum roles. */
function SystemPill() {
  return (
    <Badge
      variant="outline"
      className="gap-1 border-muted-foreground/25 bg-muted/40 text-[10px] font-medium text-muted-foreground"
    >
      <ShieldCheck className="size-3" />
      System
    </Badge>
  );
}

/** The "Superuser" pill for the one `admin` role (total bypass). */
function SuperuserPill() {
  return (
    <Badge
      variant="outline"
      className="gap-1 border-amber-500/30 bg-amber-500/10 text-[10px] font-medium text-amber-600 dark:text-amber-400"
    >
      <Crown className="size-3" />
      Superuser
    </Badge>
  );
}

/** Short human label for a landing-route page key (path tail, title-cased). */
function landingLabel(route: string): string {
  const tail = route.split("/").filter(Boolean).pop() ?? route;
  return tail.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * One role card — built-in OR custom, ONE shape. Shows the role's identity
 * icon/accent, a System pill (Superuser on `admin`), its page/capability +
 * holder counts, an optional landing-route row, ONE "Open" CTA into the editor,
 * and a kebab (⋯) for Open · Duplicate · Rename · Assign · Delete. `admin`
 * shows "Full access" instead of counts and is not editor-linked.
 */
function RoleCard({ role }: { role: RoleSummary }) {
  const visual = roleVisual(role);
  // `admin` is the total-bypass superuser — never editable, not linked.
  const hasEditor = !role.isSuperuser && role.id !== null;

  return (
    <StatPanel
      title={role.name}
      icon={visual.icon}
      accent={visual.accent}
      action={
        <div className="flex items-center gap-1.5">
          {role.isSuperuser ? <SuperuserPill /> : role.isSystem ? <SystemPill /> : null}
          <RoleCardActions role={role} />
        </div>
      }
    >
      <div className="space-y-0.5">
        {role.description ? (
          <p className="mb-1 line-clamp-2 text-xs text-muted-foreground">
            {role.description}
          </p>
        ) : null}
        {role.isSuperuser ? (
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
        {!role.isSuperuser && role.landingRoute ? (
          <PanelRow
            label="Lands on"
            value={
              <span className="inline-flex items-center gap-1">
                <Compass className="size-3.5 text-muted-foreground" />
                {landingLabel(role.landingRoute)}
              </span>
            }
          />
        ) : null}
        {!role.isSystem ? (
          <PanelRow label="Updated" value={formatDateTime(role.updatedAt)} />
        ) : null}
      </div>
      <div className="mt-3">
        {hasEditor ? (
          <Link
            href={`/admin-users/roles/${role.id}`}
            className="inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <ArrowRight className="size-3.5" />
            Open
          </Link>
        ) : (
          <div className="inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-input bg-muted/30 px-3 text-xs font-medium text-muted-foreground">
            <ShieldCheck className="size-3.5" />
            Bypasses all checks
          </div>
        )}
      </div>
    </StatPanel>
  );
}

/** The ONE unified roles grid — system roles first, then custom presets. */
export function RolesGrid({ roles }: { roles: RoleSummary[] }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {roles.map((role) => (
        <RoleCard key={role.key} role={role} />
      ))}
    </div>
  );
}
