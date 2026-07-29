import { Suspense } from "react";
import { pgArrayParam } from "@/lib/drizzle-array-param";
import { after } from "next/server";
import {
  AlertTriangle,
  Trash2,
  Archive,
  Clock,
  RefreshCw,
} from "lucide-react";
import { adminDrizzle, sql } from "@/lib/drizzle";
import { requirePageAccess } from "@/lib/dal";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
  KpiTile,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import {
  SectionHeadingSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";
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

  // Shell-first: the hero paints immediately; the admin-DB reads stream in
  // behind the Suspense boundary (house rule — no heavy await in the page
  // body). loading.tsx mirrors the same chrome for cold navigations.
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

      <Suspense fallback={<DeletedUsersBodySkeleton />}>
        <DeletedUsersBody />
      </Suspense>
    </div>
  );
}

// Mirrors the KPI grid + snapshots table from loading.tsx (sans hero, which
// the page shell already painted) so the streamed-in body doesn't jump.
function DeletedUsersBodySkeleton() {
  return (
    <>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="rounded-xl border bg-card px-3 py-2.5 sm:px-4 sm:py-3"
          >
            <div className="flex items-center gap-1.5 sm:gap-2">
              <Skeleton className="size-3.5 rounded sm:size-4" />
              <Skeleton className="h-3 w-20 rounded sm:w-24" />
            </div>
            <Skeleton className="mt-1.5 h-5 w-16 rounded sm:mt-2 sm:h-6 sm:w-20" />
          </div>
        ))}
      </div>
      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={160} />
        <TableSkeleton rows={10} columns={5} />
      </div>
    </>
  );
}

async function DeletedUsersBody() {
  // Both admin-DB reads behind one safeQuery so a slow/failed query degrades
  // to an empty (clearly flagged) list instead of hanging or crashing the
  // route — same pattern as the sibling list pages.
  const listResult = await safeQuery(
    async () => {
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
      return { snapshots, admins };
    },
    { snapshots: [], admins: [] },
    "users.deleted.snapshots",
    REWARD_QUERY_TIMEOUT_MS,
  );
  const { snapshots, admins } = listResult.data;
  const listFailed = listResult.error !== null;

  const adminLabels = new Map(
    admins.map((a) => [a.id, a.display_username ?? a.username]),
  );

  // KPI counts: total live snapshots + how many haven't been restored
  // yet (the "actually recoverable" set).
  const recoverableCount = snapshots.filter(
    (s) => s.restored_at === null,
  ).length;
  const restoredCount = snapshots.length - recoverableCount;

  return (
    <>
      {listFailed && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3"
        >
          <AlertTriangle
            aria-hidden
            className="mt-0.5 size-4 shrink-0 text-amber-500"
          />
          <p className="text-xs text-amber-700 dark:text-amber-300">
            Couldn&apos;t load deleted-user snapshots — the query timed out or
            failed. This is a{" "}
            <span className="font-medium">query error, not zero results</span>
            . Refresh to retry.
          </p>
        </div>
      )}

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
    </>
  );
}
