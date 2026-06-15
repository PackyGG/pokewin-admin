"use client";

import { useRouter } from "next/navigation";
import {
  Crown,
  KeyRound,
  Clock,
  ShieldCheck,
  Wallet,
  Users as UsersIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Avatar,
  AvatarFallback,
} from "@/components/ui/avatar";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/empty-state";
import { ROLE_COLORS } from "@/lib/constants";
import { formatRelative } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { transition } from "@/components/ux";
import { AdminUserActions } from "./admin-user-actions";
import type { AdminUserRow } from "./admin-users-table";

/** Two-letter initial for the avatar fallback (display name → username). */
function initialsOf(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
}

/** Role pills — same vocabulary + colors as the table's RoleBadges. */
function RoleBadges({ roles }: { roles: AdminUserRow["roles"] }) {
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

/** One admin card — mirrors every field the table surfaces, laid out cleanly. */
function AdminCard({
  row,
  isCurrentUserAdmin,
  currentUserId,
  rolesColumnExists,
}: {
  row: AdminUserRow;
  isCurrentUserAdmin: boolean;
  currentUserId: string;
  rolesColumnExists: boolean;
}) {
  const router = useRouter();
  const display = row.displayUsername ?? row.username;
  const isSelf = row.id === currentUserId;

  return (
    <Card
      className={cn(
        "group relative flex cursor-pointer flex-col gap-3 rounded-xl border bg-card p-4 hover:border-primary/40 hover:bg-accent/30 hover:shadow-sm",
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
      {/* Header: avatar + identity + kebab. */}
      <div className="flex items-start gap-3">
        <Avatar size="lg" className="shrink-0">
          <AvatarFallback className="bg-primary/10 font-semibold text-primary">
            {initialsOf(display)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <span className="truncate text-sm font-semibold">{display}</span>
            {isSelf && (
              <span className="text-[10px] font-normal text-muted-foreground">
                (you)
              </span>
            )}
            {row.isOwner && (
              <Badge
                variant="outline"
                className="bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30"
              >
                <Crown className="mr-1 size-3" />
                Owner
              </Badge>
            )}
          </div>
          <p className="truncate text-xs text-muted-foreground">
            @{row.username}
          </p>
          <p className="truncate text-[11px] text-muted-foreground/80">
            {row.email}
          </p>
        </div>
        {/* Kebab — same actions as the table; stop click bubbling so the
            menu / dialogs never trigger the card's navigate handler. */}
        <span
          className="-mr-1 -mt-1 shrink-0"
          onClick={(e) => e.stopPropagation()}
        >
          <AdminUserActions
            userId={row.id}
            username={display}
            isActive={row.isActive}
            totpEnabled={row.totpEnabled}
            roles={row.roles}
            isSelf={isSelf}
            rolesColumnExists={rolesColumnExists}
          />
        </span>
      </div>

      {/* Roles + status + 2FA pills. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <RoleBadges roles={row.roles} />
        <Badge
          variant="outline"
          className={
            row.isActive
              ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
              : "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30"
          }
        >
          {row.isActive ? "Active" : "Inactive"}
        </Badge>
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
            {row.balanceLimitCount} cap{row.balanceLimitCount === 1 ? "" : "s"}
          </Badge>
        )}
      </div>

      {/* Footer meta: access summary + last login. */}
      <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-2.5 text-[11px] text-muted-foreground">
        <span
          className={cn(
            "inline-flex items-center gap-1",
            row.isAdmin && "font-medium text-purple-600 dark:text-purple-400",
          )}
        >
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
          {row.lastLoginAt ? formatRelative(row.lastLoginAt) : "Never"}
        </span>
        {row.activeSessions > 0 && (
          <span className="inline-flex items-center gap-1 font-medium text-emerald-600 dark:text-emerald-400">
            <span className="size-1.5 rounded-full bg-emerald-500" />
            {row.activeSessions} active
          </span>
        )}
      </div>
    </Card>
  );
}

/**
 * Gallery view of the admin-user list — a responsive grid of admin cards.
 * Same data + actions as the table, in a scan-friendly box layout. The whole
 * card links to /admin-users/[id]; the kebab keeps every row action reachable.
 *
 * Responsive grid: 1 col (mobile) → 2 (sm) → 3 (xl). No horizontal overflow.
 */
export function AdminUsersGallery({
  rows,
  isCurrentUserAdmin,
  currentUserId,
  rolesColumnExists,
}: {
  rows: AdminUserRow[];
  isCurrentUserAdmin: boolean;
  currentUserId: string;
  rolesColumnExists: boolean;
}) {
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
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {rows.map((row) => (
        <AdminCard
          key={row.id}
          row={row}
          isCurrentUserAdmin={isCurrentUserAdmin}
          currentUserId={currentUserId}
          rolesColumnExists={rolesColumnExists}
        />
      ))}
    </div>
  );
}
