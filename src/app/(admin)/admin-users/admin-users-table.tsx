"use client";

import { useRouter } from "next/navigation";
import {
  ShieldCheck,
  ChevronRight,
  Clock,
  Wallet,
  Users as UsersIcon,
  KeyRound,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/empty-state";
import { ROLE_COLORS } from "@/lib/constants";
import { formatDateTime, formatRelative } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { transition } from "@/components/ux";
import type { AdminRole } from "@/lib/dal";
import { AdminUserActions } from "./admin-user-actions";

/**
 * One admin row, pre-shaped on the server. Only safe, non-secret fields —
 * never password_hash / totp_secret / recovery_codes.
 */
export type AdminUserRow = {
  id: string;
  username: string;
  displayUsername: string | null;
  email: string;
  /** Effective system-role set (multi-role aware, always non-empty). */
  roles: AdminRole[];
  isActive: boolean;
  totpEnabled: boolean;
  createdAt: string;
  /** Max(logged_in_at) across this admin's sessions, or null if never. */
  lastLoginAt: string | null;
  /** Count of currently-active (not logged-out, not expired) sessions. */
  activeSessions: number;
  /** True if the user holds `admin` — they bypass the page list entirely. */
  isAdmin: boolean;
  /** Number of page-route grants in allowed_pages (excludes __can_*). */
  pageAccessCount: number;
  /** Number of capability (`__can_*`) grants in allowed_pages. */
  capabilityCount: number;
  /** Number of balance-limit rows (admin-viewer only; 0 otherwise). */
  balanceLimitCount: number;
};

function RoleBadges({ roles }: { roles: AdminRole[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {roles.map((r) => (
        <Badge
          key={r}
          variant="outline"
          className={cn("text-[10px] uppercase tracking-wide", ROLE_COLORS[r])}
        >
          {r.replace("_", " ")}
        </Badge>
      ))}
    </div>
  );
}

function TotpBadge({ enabled }: { enabled: boolean }) {
  return (
    <Badge
      variant="outline"
      className={
        enabled
          ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
          : "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30"
      }
    >
      {enabled ? "Enabled" : "Not set up"}
    </Badge>
  );
}

function StatusBadge({ active }: { active: boolean }) {
  return (
    <Badge
      variant="outline"
      className={
        active
          ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
          : "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30"
      }
    >
      {active ? "Active" : "Inactive"}
    </Badge>
  );
}

/**
 * Compact summary of what an admin can reach: "Full access" for admins
 * (they bypass the page list), otherwise "N pages · M actions".
 */
function AccessSummary({ row }: { row: AdminUserRow }) {
  if (row.isAdmin) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-purple-600 dark:text-purple-400">
        <KeyRound className="size-3" />
        Full access
      </span>
    );
  }
  return (
    <span className="text-xs text-muted-foreground">
      {row.pageAccessCount} page{row.pageAccessCount === 1 ? "" : "s"}
      {row.capabilityCount > 0
        ? ` · ${row.capabilityCount} action${row.capabilityCount === 1 ? "" : "s"}`
        : ""}
    </span>
  );
}

/** Last-login cell — relative time + a green dot when a session is live. */
function LastLoginCell({ row }: { row: AdminUserRow }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-sm">
        {row.lastLoginAt ? formatRelative(row.lastLoginAt) : "Never"}
      </span>
      {row.activeSessions > 0 && (
        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
          <span className="size-1.5 rounded-full bg-emerald-500" />
          {row.activeSessions} active session{row.activeSessions === 1 ? "" : "s"}
        </span>
      )}
    </div>
  );
}

export function AdminUsersTable({
  rows,
  isCurrentUserAdmin,
  currentUserId,
  rolesColumnExists,
}: {
  rows: AdminUserRow[];
  isCurrentUserAdmin: boolean;
  currentUserId: string;
  /** Whether admin_users.roles is migrated — gates the multi-role notice. */
  rolesColumnExists: boolean;
}) {
  const router = useRouter();

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border">
        <EmptyState
          icon={UsersIcon}
          title="No admin users"
          description="Create one with the button above."
          compact
        />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* Desktop table (>=md). Horizontal scroll guard so the columns
          never blow up the layout on tablet widths. */}
      <div className="hidden rounded-xl border overflow-x-auto md:block">
        <table className="w-full">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Admin
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Roles
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                2FA
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Status
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Access
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Last login
              </th>
              {isCurrentUserAdmin && (
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Limits
                </th>
              )}
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Created
              </th>
              <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.id}
                className={cn(
                  "group cursor-pointer border-b last:border-b-0 hover:bg-accent/40",
                  transition("colors", "fast"),
                )}
                onClick={() => router.push(`/admin-users/${row.id}`)}
                role="link"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter") router.push(`/admin-users/${row.id}`);
                }}
                aria-label={`View ${row.username}`}
              >
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">
                        {row.displayUsername ?? row.username}
                        {row.id === currentUserId && (
                          <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">
                            (you)
                          </span>
                        )}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {row.email}
                      </div>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <RoleBadges roles={row.roles} />
                </td>
                <td className="px-4 py-3">
                  <TotpBadge enabled={row.totpEnabled} />
                </td>
                <td className="px-4 py-3">
                  <StatusBadge active={row.isActive} />
                </td>
                <td className="px-4 py-3">
                  <AccessSummary row={row} />
                </td>
                <td className="px-4 py-3">
                  <LastLoginCell row={row} />
                </td>
                {isCurrentUserAdmin && (
                  <td className="px-4 py-3">
                    {row.balanceLimitCount > 0 ? (
                      <Badge
                        variant="outline"
                        className="bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30"
                      >
                        {row.balanceLimitCount} cap
                        {row.balanceLimitCount === 1 ? "" : "s"}
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                )}
                <td className="px-4 py-3 text-sm text-muted-foreground">
                  {formatDateTime(row.createdAt)}
                </td>
                <td
                  className="px-4 py-3"
                  // Clicks on the kebab / its menu must not navigate the row.
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="flex items-center justify-end gap-1">
                    <AdminUserActions
                      userId={row.id}
                      username={row.displayUsername ?? row.username}
                      isActive={row.isActive}
                      totpEnabled={row.totpEnabled}
                      roles={row.roles}
                      isSelf={row.id === currentUserId}
                      rolesColumnExists={rolesColumnExists}
                    />
                    <ChevronRight
                      aria-hidden
                      className="pointer-events-none size-4 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-muted-foreground"
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile card list (<md) — the wide table overflows badly at 360px,
          so each admin renders as a stacked, tappable card. */}
      <div className="space-y-2 md:hidden">
        {rows.map((row) => (
          <div
            key={row.id}
            className={cn(
              "cursor-pointer rounded-xl border bg-card p-3 active:bg-accent/30",
              transition("colors", "fast"),
            )}
            onClick={() => router.push(`/admin-users/${row.id}`)}
            role="link"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter") router.push(`/admin-users/${row.id}`);
            }}
            aria-label={`View ${row.username}`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-medium">
                    {row.displayUsername ?? row.username}
                  </span>
                  {row.id === currentUserId && (
                    <span className="text-[10px] text-muted-foreground">
                      (you)
                    </span>
                  )}
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground/40" />
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  {row.email}
                </p>
              </div>
              <span
                className="shrink-0"
                onClick={(e) => e.stopPropagation()}
              >
                <AdminUserActions
                  userId={row.id}
                  username={row.displayUsername ?? row.username}
                  isActive={row.isActive}
                  totpEnabled={row.totpEnabled}
                  roles={row.roles}
                  isSelf={row.id === currentUserId}
                  rolesColumnExists={rolesColumnExists}
                />
              </span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <RoleBadges roles={row.roles} />
              <StatusBadge active={row.isActive} />
              <Badge
                variant="outline"
                className={
                  row.totpEnabled
                    ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
                    : "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30"
                }
              >
                <ShieldCheck className="mr-1 size-3" />
                {row.totpEnabled ? "2FA on" : "2FA off"}
              </Badge>
              {isCurrentUserAdmin && row.balanceLimitCount > 0 && (
                <Badge
                  variant="outline"
                  className="bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30"
                >
                  <Wallet className="mr-1 size-3" />
                  {row.balanceLimitCount} cap
                  {row.balanceLimitCount === 1 ? "" : "s"}
                </Badge>
              )}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <KeyRound className="size-3" />
                {row.isAdmin
                  ? "Full access"
                  : `${row.pageAccessCount} page${row.pageAccessCount === 1 ? "" : "s"}${
                      row.capabilityCount > 0
                        ? ` · ${row.capabilityCount} action${row.capabilityCount === 1 ? "" : "s"}`
                        : ""
                    }`}
              </span>
              <span className="inline-flex items-center gap-1">
                <Clock className="size-3" />
                {row.lastLoginAt ? formatRelative(row.lastLoginAt) : "Never logged in"}
              </span>
              {row.activeSessions > 0 && (
                <span className="inline-flex items-center gap-1 font-medium text-emerald-600 dark:text-emerald-400">
                  <span className="size-1.5 rounded-full bg-emerald-500" />
                  {row.activeSessions} active
                </span>
              )}
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">
              Created {formatDateTime(row.createdAt)}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
