"use client";

import { useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { AdminUserDetail, AdminAuditStats } from "@/lib/queries/admin-users";
import type { PaginatedResult } from "@/lib/types";
import { ProfileCard, Row, StatsCards } from "./profile-card";
import { BalanceLimitsCard, LimitRow, type BalanceLimit } from "./balance-limits-card";
import { ManagementActions } from "./management-actions";
import { LinkMainUserCard } from "./link-main-user-card";
import { RolesCard } from "./assign-role-card";
import { PermissionsSection } from "./permissions-section";
import { OwnerCard } from "./owner-card";
import {
  AuditEventsTable,
  EventDetails,
  Pagination,
  type AdminAuditEventItem,
} from "./audit-events-table";

type Props = {
  detail: AdminUserDetail;
  auditStats: AdminAuditStats;
  auditEvents: PaginatedResult<AdminAuditEventItem>;
  balanceLimits: BalanceLimit[];
  isCurrentUserAdmin: boolean;
  /** Whether admin_users.roles is migrated — gates the multi-role notice. */
  rolesColumnExists: boolean;
  /** Whether the current viewer is the MAIN owner (motha) — gates the owner card. */
  viewerIsMainOwner: boolean;
};

export function AdminUserTabs({ detail, auditStats, auditEvents, balanceLimits, isCurrentUserAdmin, rolesColumnExists, viewerIsMainOwner }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  function navigateParam(paramName: string, value: number | string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set(paramName, String(value));
    if (paramName === "auditPerPage" || paramName === "auditEventType" || paramName === "auditSearch") {
      params.delete("auditPage");
    }
    router.push(`?${params.toString()}`, { scroll: false });
  }

  function clearParam(paramName: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.delete(paramName);
    params.delete("auditPage");
    router.push(`?${params.toString()}`, { scroll: false });
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:gap-4 md:grid-cols-2 lg:grid-cols-3">
        <ProfileCard detail={detail} />
        <StatsCards auditStats={auditStats} />
        {isCurrentUserAdmin && (
          <BalanceLimitsCard adminUserId={detail.id} initialLimits={balanceLimits} />
        )}
      </div>
      <ManagementActions
        detail={detail}
        startTransition={startTransition}
      />
      {/* Owner / ultra-admin management — visible ONLY to the main owner
          (motha). Lets motha grant/revoke owner on any admin (motha's own row
          renders read-only "permanent"). Server-gated via viewerIsMainOwner. */}
      {viewerIsMainOwner && (
        <OwnerCard
          adminUserId={detail.id}
          username={detail.username}
          isOwner={detail.isOwner}
          isMainOwner={detail.isMainOwner}
        />
      )}
      {isCurrentUserAdmin && detail.roles.includes("creator") && (
        <LinkMainUserCard detail={detail} />
      )}
      {/* System-role editor (multi-select) + per-user permission editor.
          Shown for any user that is NOT an admin — admins bypass the page
          list entirely, so the editor is meaningless for them. Uses the
          effective role set so a multi-role user that merely INCLUDES admin
          still hides it. */}
      {isCurrentUserAdmin && !detail.roles.includes("admin") && (
        <>
          <RolesCard
            adminUserId={detail.id}
            currentRoles={detail.roles}
            rolesColumnExists={rolesColumnExists}
          />
          <PermissionsSection detail={detail} />
        </>
      )}
      {/* Audit events feed is admin-only — the same gate the page.tsx
          server fetch applies. Non-admin viewers with /admin-users access
          (e.g. via a custom role) never see the audit list. */}
      {isCurrentUserAdmin && (
        <AuditEventsTable
          auditEvents={auditEvents}
          activeEventType={searchParams.get("auditEventType") ?? "all"}
          activeSearch={searchParams.get("auditSearch") ?? ""}
          onPageChange={(p) => navigateParam("auditPage", p)}
          onPerPageChange={(pp) => navigateParam("auditPerPage", pp)}
          onEventTypeChange={(v) => v === "all" ? clearParam("auditEventType") : navigateParam("auditEventType", v)}
          onSearchChange={(v) => v ? navigateParam("auditSearch", v) : clearParam("auditSearch")}
        />
      )}
    </div>
  );
}

/* ── Re-exports for backward compatibility ── */
export {
  ProfileCard,
  Row,
  StatsCards,
  BalanceLimitsCard,
  LimitRow,
  ManagementActions,
  LinkMainUserCard,
  PermissionsSection,
  AuditEventsTable,
  EventDetails,
  Pagination,
};
export type { AdminAuditEventItem, BalanceLimit };
