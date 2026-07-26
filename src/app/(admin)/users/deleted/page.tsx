import { pgArrayParam } from "@/lib/drizzle-array-param";
import { after } from "next/server";
import { Trash2, Archive, Clock, RefreshCw } from "lucide-react";
import { adminDrizzle, sql } from "@/lib/drizzle";
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

  // Purge expired snapshots after the response. The listing query excludes
  // them independently, so cleanup never participates in page rendering.
  after(() => {
    void adminDrizzle
      .execute(sql`DELETE FROM admin_deleted_users WHERE expires_at < NOW()`)
      .catch((err) => {
        console.error("[/users/deleted] expired-snapshot purge failed:", err);
      });
  });

  // Listing query — newest non-expired deletions first.
  const snapshots = (
    await adminDrizzle.execute<{
      id: string;
      username: string;
      email: string;
      deleted_at: Date | string;
      deleted_by: string;
      expires_at: Date | string;
      restored_at: Date | string | null;
      restored_by: string | null;
    }>(sql`
      SELECT id, username, email, deleted_at, deleted_by, expires_at,
             restored_at, restored_by
      FROM admin_deleted_users
      WHERE expires_at >= NOW()
      ORDER BY deleted_at DESC
      LIMIT 200
    `)
  ).rows;

  // Resolve admin usernames for the deleted_by / restored_by display.
  // Single query covering both sets, then a Map lookup per row.
  const adminIds = new Set<string>();
  for (const row of snapshots) {
    adminIds.add(row.deleted_by);
    if (row.restored_by) adminIds.add(row.restored_by);
  }
  const admins = adminIds.size
    ? (
        await adminDrizzle.execute<{
          id: string;
          username: string;
          display_username: string | null;
        }>(sql`
          SELECT id, username, display_username
          FROM admin_users
          WHERE id = ANY(${pgArrayParam(Array.from(adminIds))}::uuid[])
        `)
      ).rows
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
              deletedAt: new Date(s.deleted_at).toISOString(),
              deletedByLabel: adminLabels.get(s.deleted_by) ?? s.deleted_by,
              expiresAt: new Date(s.expires_at).toISOString(),
              restoredAt: s.restored_at
                ? new Date(s.restored_at).toISOString()
                : null,
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
