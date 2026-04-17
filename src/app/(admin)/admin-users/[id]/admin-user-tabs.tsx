"use client";

import { useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { AdminUserDetail, AdminAuditStats } from "@/lib/queries/admin-users";
import type { PaginatedResult } from "@/lib/types";
import { ProfileCard, Row, StatsCards } from "./profile-card";
import { BalanceLimitsCard, LimitRow, type BalanceLimit } from "./balance-limits-card";
import { ManagementActions, ChangeRoleDialog } from "./management-actions";
import { LinkMainUserCard } from "./link-main-user-card";
import { PermissionsSection } from "./permissions-section";
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
};

export function AdminUserTabs({ detail, auditStats, auditEvents, balanceLimits, isCurrentUserAdmin }: Props) {
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
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <ProfileCard detail={detail} />
        <StatsCards auditStats={auditStats} />
        {isCurrentUserAdmin && (
          <BalanceLimitsCard adminUserId={detail.id} initialLimits={balanceLimits} />
        )}
      </div>
      <ManagementActions detail={detail} startTransition={startTransition} />
      {isCurrentUserAdmin && detail.role === "creator" && (
        <LinkMainUserCard detail={detail} />
      )}
      {isCurrentUserAdmin && detail.role !== "admin" && (
        <PermissionsSection detail={detail} />
      )}
      <AuditEventsTable
        auditEvents={auditEvents}
        activeEventType={searchParams.get("auditEventType") ?? "all"}
        activeSearch={searchParams.get("auditSearch") ?? ""}
        onPageChange={(p) => navigateParam("auditPage", p)}
        onPerPageChange={(pp) => navigateParam("auditPerPage", pp)}
        onEventTypeChange={(v) => v === "all" ? clearParam("auditEventType") : navigateParam("auditEventType", v)}
        onSearchChange={(v) => v ? navigateParam("auditSearch", v) : clearParam("auditSearch")}
      />
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
  ChangeRoleDialog,
  LinkMainUserCard,
  PermissionsSection,
  AuditEventsTable,
  EventDetails,
  Pagination,
};
export type { AdminAuditEventItem, BalanceLimit };
