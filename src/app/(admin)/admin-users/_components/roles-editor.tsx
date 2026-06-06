"use client";

import { X, Plus, ShieldCheck, AlertTriangle } from "lucide-react";
import { ROLE_COLORS } from "@/lib/constants";
import { cn } from "@/lib/utils";
import {
  ALL_ADMIN_ROLES,
  isPersistableAdminRole,
  type AdminRole,
} from "@/lib/admin-roles";

const ROLE_LABELS: Record<AdminRole, string> = {
  admin: "Admin",
  support: "Support",
  marketing: "Marketing",
  creator: "Creator",
  pack_creator: "Pack Creator",
  creator_manager: "Creator Manager",
};

const ROLE_DESCRIPTIONS: Record<AdminRole, string> = {
  admin: "Full access — bypasses every page & capability gate.",
  support: "User support workflow (lands on /users).",
  marketing: "Marketing surfaces (lands on /analytics).",
  creator: "Creator self-service portal.",
  pack_creator: "Content management — packs, cards, sets, upgrader.",
  creator_manager:
    "Creator Hub manager (CM team). Code-level role for v1 — needs an admin-DB enum value before it can be assigned to a user.",
};

/**
 * Shared add/remove role manager used by BOTH role-edit surfaces (the
 * /admin-users 3-dots dialog and the /admin-users/[id] detail page). Renders
 * the user's selected roles as removable chips and an "Add role" picker that
 * only lists roles not yet held — so adding/removing several roles is one
 * click each, not a buried checkbox hunt.
 *
 * Controlled: the parent owns the `selected` set and the 2FA + submit
 * controls (the two hosts use different dialog primitives, so only the BODY
 * is shared here). State, dirty-tracking, and persistence stay in the host.
 *
 * Honest no-migration state: when `rolesColumnExists` is false the additive
 * `admin_users.roles` column hasn't been migrated yet, so the server
 * (writeAdminUserWithRoles) can only persist the single primary role and
 * SILENTLY DROPS the rest. We surface that truthfully — an inline warning
 * the moment more than one role is selected — instead of letting the save
 * pretend it worked. Once the column exists the warning never shows and full
 * multi-role assignment just works.
 */
export function RolesEditor({
  selected,
  onChange,
  rolesColumnExists,
  disabled,
}: {
  selected: Set<AdminRole>;
  onChange: (next: Set<AdminRole>) => void;
  /** Whether admin_users.roles physically exists on the DB (server probe). */
  rolesColumnExists: boolean;
  disabled?: boolean;
}) {
  function remove(role: AdminRole) {
    const next = new Set(selected);
    next.delete(role);
    onChange(next);
  }

  function add(role: AdminRole) {
    const next = new Set(selected);
    next.add(role);
    onChange(next);
  }

  // Render chips in canonical priority order regardless of insertion order.
  // Already-held roles render even if not currently persistable (forward-
  // compat: a creator_manager assignment made once the admin-DB enum exists
  // still shows + can be removed).
  const ordered = ALL_ADMIN_ROLES.filter((r) => selected.has(r));
  // The picker only offers roles that can actually be PERSISTED to the
  // admin-DB `admin_role` enum. `creator_manager` is a code-level role for
  // v1 (no DB enum value yet), so it's deliberately not selectable here —
  // offering it would let an admin pick a role the save then silently drops.
  const available = ALL_ADMIN_ROLES.filter(
    (r) => !selected.has(r) && isPersistableAdminRole(r),
  );
  const empty = selected.size === 0;
  // Pre-migration + the operator is trying to assign more than one role:
  // only the primary will actually persist. Say so plainly.
  const multiRoleBlocked = !rolesColumnExists && selected.size > 1;

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Roles fill this admin&apos;s permissions as baselines (unioned). You
        can grant or revoke individual permissions below — those adjustments
        survive a later role change.
      </p>

      {/* Current roles as removable chips. */}
      <div className="space-y-1.5">
        <span className="text-xs font-medium text-muted-foreground">
          Assigned roles
        </span>
        {empty ? (
          <p className="rounded-md border border-dashed border-rose-500/40 px-3 py-2.5 text-xs text-rose-500">
            No roles assigned — pick at least one below.
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {ordered.map((r) => (
              <span
                key={r}
                className={cn(
                  "inline-flex items-center gap-1 rounded-4xl border px-2 py-0.5 text-xs font-medium",
                  ROLE_COLORS[r],
                )}
              >
                <ShieldCheck className="size-3" />
                {ROLE_LABELS[r]}
                <button
                  type="button"
                  onClick={() => remove(r)}
                  disabled={disabled}
                  aria-label={`Remove ${ROLE_LABELS[r]} role`}
                  className="ml-0.5 rounded-full p-0.5 opacity-70 transition-opacity hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Add-role picker — inline clickable pills for every role not already
          held. Plain buttons (no portal / no controlled-select semantics):
          one click adds the role, the pill then moves up into the chip row.
          Each pill shows its access description as a tooltip. */}
      {available.length > 0 && (
        <div className="space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            Add a role
          </span>
          <div className="flex flex-wrap gap-1.5">
            {available.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => add(r)}
                disabled={disabled}
                title={ROLE_DESCRIPTIONS[r]}
                className="inline-flex items-center gap-1 rounded-4xl border border-dashed border-input px-2 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:border-input hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Plus className="size-3" />
                {ROLE_LABELS[r]}
              </button>
            ))}
          </div>
        </div>
      )}

      {multiRoleBlocked && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Multiple roles require a pending database migration (
            <code className="font-mono">npm run admin:migrate</code>). Until
            it runs, only the primary role is saved — the extra roles will be
            dropped.
          </span>
        </div>
      )}
    </div>
  );
}
