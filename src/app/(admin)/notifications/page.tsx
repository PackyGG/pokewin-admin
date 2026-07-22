import { Suspense } from "react";
import { Megaphone } from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { TableSkeleton } from "@/components/loading-skeletons";
import { safeQuery } from "@/lib/errors/safe-query";
import { readDbEnvFromCookie } from "@/lib/db-env";
import { getAnnouncements } from "@/lib/backend-api/announcements";
import { AnnouncementsContent } from "./announcements-content";
import { DirectNotificationsContent } from "./direct-notifications-content";
import { NotificationsTabNav } from "./notifications-tab-nav";
import { parseNotificationTab } from "./tabs";

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

  return (
    <AnnouncementsContent
      announcements={result.data}
      total={result.meta.total}
      page={page}
      perPage={PAGE_SIZE}
      loadError={error}
      canManage={canManage}
    />
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

  // Read-only viewers (page access without the manage capability) see the
  // list but no create/revoke controls — same dual-gate shape as /security.
  const canManage = await requireCapability(
    session,
    "__can_manage_announcements",
    "manage announcements",
  )
    .then(() => true)
    .catch(() => false);

  // Per-user sends are a separate capability: they write one row per
  // recipient with per-user content, a different blast radius from one
  // broadcast row.
  const canSendDirect = await requireCapability(
    session,
    "__can_send_user_notifications",
    "send user notifications",
  )
    .then(() => true)
    .catch(() => false);

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Megaphone}
          title="Notifications"
          subtitle="Broadcast a site-wide announcement, or send a personal notification straight into one user's feed."
        />
      </PageHero>

      <NotificationsTabNav />

      <FadeIn>
        {tab === "direct" ? (
          <DirectNotificationsContent
            canSend={canSendDirect}
            dbEnv={await readDbEnvFromCookie()}
          />
        ) : (
          <Suspense
            key={page}
            fallback={
              <div className="space-y-4">
                <TableSkeleton rows={8} columns={5} />
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
