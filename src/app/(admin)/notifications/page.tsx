import { Suspense } from "react";
import { requirePageAccess } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { TableSkeleton } from "@/components/loading-skeletons";
import { safeQuery } from "@/lib/errors/safe-query";
import {
  getAnnouncementReadCounts,
  getAnnouncements,
} from "@/lib/backend-api/announcements";
import { getDirectNotificationAvailability } from "@/lib/backend-api/user-notifications-availability";
import { AnnouncementsContent } from "./announcements-content";
import { DirectNotificationsContent } from "./direct-notifications-content";
import { DirectNotificationHistory } from "./direct-notification-history";
import { NotificationsTabNav } from "./notifications-tab-nav";
import { parseNotificationTab } from "./tabs";
import { canViewProtectedAuditActivity } from "@/lib/audit-visibility";

export const metadata = { title: "Notifications" };

const PAGE_SIZE = 25;

async function AnnouncementsSection({
  page,
  canManage,
}: {
  page: number;
  canManage: boolean;
}) {
  const offset = (page - 1) * PAGE_SIZE;
  const { data: result, error } = await safeQuery(
    () => getAnnouncements({ limit: PAGE_SIZE, offset }),
    {
      success: false,
      data: [],
      meta: { total: 0, limit: PAGE_SIZE, offset, hasMore: false },
    },
    "notifications.announcements",
    15_000,
  );
  const { data: readCounts, error: readCountsError } = await safeQuery(
    () => getAnnouncementReadCounts(result.data.map((item) => item.id)),
    {},
    "notifications.announcementReadCounts",
    10_000,
  );

  return (
    <AnnouncementsContent
      announcements={result.data}
      total={result.meta.total}
      page={page}
      perPage={PAGE_SIZE}
      loadError={error}
      readCounts={readCounts}
      readCountsUnavailable={readCountsError !== null}
      canManage={canManage}
    />
  );
}

/**
 * Composer + send history. Availability resolves the env a send would ACTUALLY
 * reach, so the unavailable card and the server-side gate can't
 * disagree. The history streams behind its own boundary — it reads the admin
 * DB and must never hold up the composer's first paint.
 */
async function DirectSection({
  canSend,
  canViewProtectedActors,
}: {
  canSend: boolean;
  canViewProtectedActors: boolean;
}) {
  const availability = await getDirectNotificationAvailability();

  return (
    <div className="space-y-8">
      <DirectNotificationsContent
        canSend={canSend}
        backendEnv={availability.backendEnv}
        ready={availability.ready}
        reason={availability.reason}
      />

      {canSend && (
        <Suspense fallback={<TableSkeleton rows={4} columns={8} />}>
          <DirectNotificationHistory
            canViewProtectedActors={canViewProtectedActors}
          />
        </Suspense>
      )}
    </div>
  );
}

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await requirePageAccess("/notifications");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const tab = parseNotificationTab(params.tab);

  // Two independent capability probes. `requireCapability` is NOT cache()d and
  // costs up to 2 admin-DB reads each, so awaiting them one after the other
  // meant up to 4 serial round-trips before the shell could render for a
  // non-admin viewer. They don't depend on each other → one wave.
  //
  //   canManage    — read-only viewers (page access without the manage
  //                  capability) see the list but no create/revoke controls,
  //                  the same dual-gate shape as /security.
  //   canSendDirect— per-user sends are a separate capability: they write one
  //                  row per recipient with per-user content, a different
  //                  blast radius from one broadcast row.
  const [canManage, canSendDirect] = await Promise.all([
    requireCapability(
      session,
      "__can_manage_announcements",
      "manage announcements",
    )
      .then(() => true)
      .catch(() => false),
    requireCapability(
      session,
      "__can_send_user_notifications",
      "send user notifications",
    )
      .then(() => true)
      .catch(() => false),
  ]);

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity />
      </PageHero>

      <NotificationsTabNav />

      <FadeIn>
        {tab === "direct" ? (
          // Boundary so the hero + tab strip paint before availability
          // resolves — an async child without one blocks the shell even when
          // its work is cheap.
          <Suspense fallback={<TableSkeleton rows={6} columns={4} />}>
            <DirectSection
              canSend={canSendDirect}
              canViewProtectedActors={canViewProtectedAuditActivity(session)}
            />
          </Suspense>
        ) : (
          <Suspense
            key={page}
            fallback={
              <div className="space-y-4">
                <TableSkeleton rows={8} columns={6} />
              </div>
            }
          >
            <AnnouncementsSection page={page} canManage={canManage} />
          </Suspense>
        )}
      </FadeIn>
    </div>
  );
}
