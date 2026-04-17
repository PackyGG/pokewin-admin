"use client";

import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDateTime, formatRelative } from "@/lib/utils/format";
import type { AdminUserDetail, AdminAuditStats } from "@/lib/queries/admin-users";

/* ── Profile Card ── */
export function ProfileCard({ detail }: { detail: AdminUserDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Profile</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <Row label="Email" value={detail.email} />
        <Row label="Username" value={detail.username} />
        <Row label="Role">
          <Badge variant="outline" className="text-xs uppercase">
            {detail.role}
          </Badge>
        </Row>
        <Row label="2FA">
          <Badge
            variant="outline"
            className={
              detail.totpEnabled
                ? "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30"
                : "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30"
            }
          >
            {detail.totpEnabled ? "Enabled" : "Not set up"}
          </Badge>
        </Row>
        <Row label="Status">
          <Badge
            variant="outline"
            className={
              detail.isActive
                ? "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30"
                : "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30"
            }
          >
            {detail.isActive ? "Active" : "Inactive"}
          </Badge>
        </Row>
        <Row label="Created" value={formatDateTime(detail.createdAt)} />
        {detail.role === "creator" && (
          <Row label="Linked User">
            {detail.linkedUser ? (
              <Link href={`/users/${detail.linkedUser.id}`} className="text-sm font-medium hover:underline">
                {detail.linkedUser.username ?? detail.linkedUser.id.slice(0, 8)}
              </Link>
            ) : (
              <span className="text-muted-foreground">Not linked</span>
            )}
          </Row>
        )}
      </CardContent>
    </Card>
  );
}

export function Row({
  label,
  value,
  children,
}: {
  label: string;
  value?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      {children ?? <span className="font-medium">{value}</span>}
    </div>
  );
}

/* ── Stats Cards ── */
export function StatsCards({ auditStats }: { auditStats: AdminAuditStats }) {
  const topTypes = auditStats.eventsByType.slice(0, 5);
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Activity Summary</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <Row label="Total Actions" value={String(auditStats.totalActions)} />
          <Row
            label="Last Active"
            value={auditStats.lastActive ? formatRelative(auditStats.lastActive) : "Never"}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Top Event Types</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {topTypes.length === 0 && (
            <p className="text-muted-foreground">No events yet</p>
          )}
          {topTypes.map((e) => (
            <div key={e.eventType} className="flex justify-between">
              <span className="text-muted-foreground">{e.eventType}</span>
              <Badge variant="secondary">{e.count}</Badge>
            </div>
          ))}
        </CardContent>
      </Card>
    </>
  );
}
