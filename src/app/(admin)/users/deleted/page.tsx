import { Trash2, Archive, Clock, RefreshCw } from "lucide-react";
import { adminDb } from "@/lib/admin-db";
import { requirePageAccess } from "@/lib/dal";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
  KpiTile,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { formatNumber } from "@/lib/utils/format";
import { DeletedUsersTable } from "./deleted-users-table";

export const metadata = { title: "Deleted Users" };

// Mirrors SNAPSHOT_RETENTION_MS in /users/actions.ts — 7 days. Used to
// derive the "expires in X days" relative label on the UI.
const SNAPSHOT_RETENTION_DAYS = 7;

export default async function DeletedUsersPage() {
  await requirePageAccess("/users/deleted");

  // Purge expired snapshots on read. Fire-and-forget — we don't need to
  // wait for the deleteMany to finish before listing the live rows.
  // The same query 100ms later would just skip them anyway because of
  // the < new Date() filter on the listing query below.
  void adminDb.admin_deleted_users
    .deleteMany({ where: { expires_at: { lt: new Date() } } })
    .catch((err) => {
      console.error("[/users/deleted] expired-snapshot purge failed:", err);
    });

  // Listing query — newest deletions first. We intentionally read AFTER
  // firing the purge so the page never shows a row that's actually
  // expired (purge may still be running but the filter handles that).
  const snapshots = await adminDb.admin_deleted_users.findMany({
    where: { expires_at: { gte: new Date() } },
    orderBy: { deleted_at: "desc" },
    take: 200,
  });

  // Resolve admin usernames for the deleted_by / restored_by display.
  // Single query covering both sets, then a Map lookup per row.
  const adminIds = new Set<string>();
  for (const row of snapshots) {
    adminIds.add(row.deleted_by);
    if (row.restored_by) adminIds.add(row.restored_by);
  }
  const admins = adminIds.size
    ? await adminDb.admin_users.findMany({
        where: { id: { in: Array.from(adminIds) } },
        select: { id: true, username: true, display_username: true },
      })
    : [];
  const adminLabels = new Map(
    admins.map((a) => [a.id, a.display_username ?? a.username]),
  );

  // KPI counts: total live snapshots + how many haven't been restored
  // yet (the "actually recoverable" set).
  const recoverableCount = snapshots.filter((s) => s.restored_at === null).length;
  const restoredCount = snapshots.length - recoverableCount;

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Archive}
          title="Deleted Users"
          subtitle={`Snapshots of users wiped from main DB. Auto-purged after ${SNAPSHOT_RETENTION_DAYS} days.`}
          accent="rose"
          backHref="/users"
        />
      </PageHero>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <KpiTile
          label="Recoverable"
          value={formatNumber(recoverableCount)}
          icon={RefreshCw}
          accent="emerald"
        />
        <KpiTile
          label="Already Restored"
          value={formatNumber(restoredCount)}
          icon={Clock}
          accent="blue"
        />
        {/* Retention Window is an informational config value (how long
            snapshots survive), not a money-loss metric — amber (neutral
            warning) keeps the house-POV color convention, where rose is
            reserved for actual losses / user gains. */}
        <KpiTile
          label="Retention Window"
          value={`${SNAPSHOT_RETENTION_DAYS} days`}
          icon={Trash2}
          accent="amber"
        />
      </div>

      <div className="space-y-3">
        <SectionHeading icon={Archive} title="Recent Snapshots" />
        <FadeIn className="space-y-4">
          <DeletedUsersTable
            rows={snapshots.map((s) => ({
              id: s.id,
              username: s.username,
              email: s.email,
              deletedAt: s.deleted_at.toISOString(),
              deletedByLabel: adminLabels.get(s.deleted_by) ?? s.deleted_by,
              expiresAt: s.expires_at.toISOString(),
              restoredAt: s.restored_at?.toISOString() ?? null,
              restoredByLabel: s.restored_by
                ? adminLabels.get(s.restored_by) ?? s.restored_by
                : null,
            }))}
          />
        </FadeIn>
      </div>
    </div>
  );
}
