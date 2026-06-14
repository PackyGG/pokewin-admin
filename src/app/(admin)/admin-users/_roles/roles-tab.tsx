import { Lock, KeyRound, Crown, UserCog, ListChecks, Sparkles } from "lucide-react";
import { requireAdmin } from "@/lib/dal";
import { adminDb } from "@/lib/admin-db";
import {
  isCreatorHubAccessOwner,
  getCreatorHubAccessSettings,
  CREATOR_HUB_TOGGLE_ROLES,
} from "@/lib/creator-hub-access";
import { isPersistableAdminRole } from "@/lib/admin-roles";
import { getRolesOverview } from "./roles-overview-data";
import { BuiltInRolesGrid, CustomRolesGrid } from "./roles-grid";
import { CreateRoleButton } from "./create-role-button";
import {
  CreatorHubAccessCard,
  type CreatorHubAccessRow,
} from "./creator-hub-access-card";
import { SectionHeading, KpiTile } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";

/** Display labels + descriptions for each per-role Creator-Hub toggle. */
const CREATOR_HUB_ROLE_LABELS: Record<
  (typeof CREATOR_HUB_TOGGLE_ROLES)[number],
  { label: string; description: string }
> = {
  admin: {
    label: "Admins",
    description:
      "Let every admin open the Creator Hub. While off, other admins are blocked — only the founder account reaches the Hub.",
  },
  creator_manager: {
    label: "Creator Managers",
    description:
      "Let every user with the Creator Manager role open the Creator Hub. Assign the role on an admin user's profile once this toggle is on.",
  },
};

/**
 * "Roles & Permissions" tab content for the merged Admins & Access surface
 * (/admin-users?tab=roles). The ENTIRE content of the former standalone
 * /settings/roles page, minus its PageHero (the shared page shell renders the
 * hero). Async server segment mounted inside a `<Suspense>` so its ADMIN-DB
 * reads only run when this tab is active (Active-Tab-Only).
 *
 *   • Built-in roles — the enum roles. Their canonical baselines are
 *     code-defined (`ROLE_BASELINES`) and LOCKED: shown read-only via the
 *     baseline inspector, never editable (`updateRolePermissions` rejects
 *     them server-side).
 *   • Custom roles — reusable presets in `admin_roles`. Created here, assigned
 *     on an admin's profile, edited at /admin-users/roles/[id]. Fully editable.
 *
 * SECURITY (CRITICAL): this surface is ADMIN-ONLY. /admin-users is gated by
 * `requirePageAccess("/admin-users")`, which a NON-admin custom role can hold —
 * but roles management must never be exposed to a non-admin. The page hides the
 * Roles tab from non-admins; this segment additionally calls `requireAdmin()`
 * as the real server-side boundary, so a non-admin hitting `?tab=roles`
 * directly is redirected before any role data is read. Every role server
 * action keeps its own `requireAdmin` gate.
 */
export async function RolesTab() {
  // Hard admin gate — the security boundary for the whole roles surface. A
  // non-admin (even one with the /admin-users page key) is redirected here,
  // before getRolesOverview() reads anything.
  const session = await requireAdmin();
  const overview = await getRolesOverview();

  // Creator-Hub access toggles are founder-only ("motha"). Resolve the
  // username from the ADMIN DB (never trust the JWT alone for a security
  // surface) and only load + render the card for the owner. A non-owner
  // admin never sees it; the server actions enforce the same gate.
  const ownerRow = await adminDb.admin_users.findUnique({
    where: { id: session.userId },
    select: { username: true },
  });
  const isHubAccessOwner = isCreatorHubAccessOwner({
    username: ownerRow?.username ?? "",
  });
  const hubAccessEnabled = isHubAccessOwner
    ? await getCreatorHubAccessSettings()
    : null;
  const hubAccessRows: CreatorHubAccessRow[] = isHubAccessOwner
    ? CREATOR_HUB_TOGGLE_ROLES.map((role) => ({
        role,
        label: CREATOR_HUB_ROLE_LABELS[role].label,
        description: CREATOR_HUB_ROLE_LABELS[role].description,
        // A role is assignable only if it's a real ADMIN-DB enum value.
        assignable: isPersistableAdminRole(role),
      }))
    : [];

  const { kpis } = overview;

  return (
    <div className="space-y-6">
      {/* KPI strip — headline counts (all read-only). */}
      <FadeIn>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <KpiTile
            label="Built-in roles"
            value={String(kpis.builtInCount)}
            sub="Locked baselines"
            icon={Lock}
            accent="amber"
          />
          <KpiTile
            label="Custom roles"
            value={String(kpis.customCount)}
            sub="Editable presets"
            icon={KeyRound}
            accent="emerald"
          />
          <KpiTile
            label="Admins"
            value={String(kpis.adminCount)}
            sub="Full access"
            icon={Crown}
            accent="blue"
          />
          <KpiTile
            label="Per-user overrides"
            value={String(kpis.overrideUserCount)}
            sub="Differ from baseline"
            icon={UserCog}
            accent="purple"
          />
          <KpiTile
            label="Total capabilities"
            value={String(kpis.totalCapabilityCount)}
            sub="Defined in catalog"
            icon={ListChecks}
            accent="cyan"
          />
        </div>
      </FadeIn>

      {/* Built-in roles — locked, read-only baselines. */}
      <div className="space-y-3">
        <SectionHeading icon={Lock} title="Built-in Roles" />
        <p className="text-sm text-muted-foreground">
          The fixed system roles. Their baselines are code-defined and locked —
          view a baseline read-only, but it can&apos;t be changed. To grant
          different access, create a custom role or set per-user access on a
          user&apos;s profile.
        </p>
        <FadeIn>
          <BuiltInRolesGrid roles={overview.builtIns} />
        </FadeIn>
      </div>

      {/* Custom roles — reusable presets stored in admin_roles. Create here,
          then assign on an admin user's profile. Fully editable. */}
      <div className="space-y-3">
        <SectionHeading
          icon={KeyRound}
          title="Custom Roles"
          action={<CreateRoleButton />}
        />
        {overview.customRoles.length === 0 ? (
          <FadeIn className="rounded-md border">
            <EmptyState
              icon={KeyRound}
              title="No custom roles yet"
              description="Use the New Role button above to create your first reusable preset."
              compact
            />
          </FadeIn>
        ) : (
          <FadeIn>
            <CustomRolesGrid roles={overview.customRoles} />
          </FadeIn>
        )}
      </div>

      {/* Creator Hub access — founder-only ("motha") per-role on/off toggles
          for who can enter the Creator Hub sub-app. Both default off. */}
      {isHubAccessOwner && hubAccessEnabled && (
        <div className="space-y-3">
          <SectionHeading icon={Sparkles} title="Creator Hub access" />
          <FadeIn>
            <CreatorHubAccessCard
              rows={hubAccessRows}
              initialEnabled={hubAccessEnabled}
            />
          </FadeIn>
        </div>
      )}
    </div>
  );
}
