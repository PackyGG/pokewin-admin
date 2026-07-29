import { Suspense } from "react";
import {
  Inbox,
  Radio,
  Send,
  Users,
} from "lucide-react";

import {
  sessionIsAdmin,
  sessionIsOwner,
  verifySession,
} from "@/lib/dal";
import {
  STAFF_NOTIFICATION_KINDS,
  countUnreadStaffNotifications,
  isStaffNotificationKind,
  listStaffNotificationRecipients,
  listStaffNotifications,
} from "@/lib/staff/notifications";
import {
  KpiTile,
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { Skeleton } from "@/components/ui/skeleton";
import { HostLink } from "@/components/host-link";
import { safeQuery } from "@/lib/errors/safe-query";
import { cn } from "@/lib/utils";
import { formatDateTime, formatRelative } from "@/lib/utils/format";
import { MarkAllButton } from "@/app/(antifraud)/antifraud/notifications/_components/mark-all-button";
import { StaffNotificationComposer } from "./staff-notification-composer";

export const metadata = { title: "Staff Notifications" };

const QUERY_TIMEOUT_MS = 10_000;

export default async function StaffNotificationsPage() {
  const session = await verifySession();
  const canManage = sessionIsAdmin(session) || sessionIsOwner(session);

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity />
      </PageHero>

      <Suspense fallback={<PageSkeleton canManage={canManage} />}>
        <NotificationsBody
          adminUserId={session.userId}
          canManage={canManage}
        />
      </Suspense>
    </div>
  );
}

async function NotificationsBody({
  adminUserId,
  canManage,
}: {
  adminUserId: string;
  canManage: boolean;
}) {
  const [
    { data: items },
    { data: unread },
    { data: recipients },
  ] = await Promise.all([
    safeQuery(
      () => listStaffNotifications(adminUserId, 50),
      [],
      "system.staff-notifications-list",
      QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => countUnreadStaffNotifications(adminUserId),
      0,
      "system.staff-notifications-unread",
      QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      listStaffNotificationRecipients,
      [],
      "system.staff-notification-recipients",
      QUERY_TIMEOUT_MS,
    ),
  ]);
  const verifiedChannels = recipients.reduce(
    (sum, recipient) => sum + recipient.verifiedChannels,
    0,
  );

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <KpiTile
          label="Unread"
          value={String(unread)}
          sub="in your staff inbox"
          icon={Inbox}
          accent="cyan"
        />
        <KpiTile
          label="Active staff"
          value={String(recipients.length)}
          sub="eligible dashboard accounts"
          icon={Users}
          accent="blue"
        />
        <KpiTile
          label="Verified channels"
          value={String(verifiedChannels)}
          sub="Discord and Telegram endpoints"
          icon={Radio}
          accent="purple"
        />
      </div>

      {canManage && (
        <section className="space-y-3">
          <SectionHeading
            icon={Send}
            title="Send a staff notification"
          />
          <p className="text-sm text-muted-foreground">
            Target selected staff, a role, or every active dashboard account.
          </p>
          <StaffNotificationComposer recipients={recipients} />
        </section>
      )}

      <section className="space-y-3">
          <SectionHeading
            icon={Inbox}
            title="Your inbox"
            action={<MarkAllButton disabled={unread === 0} />}
          />
          <p className="text-sm text-muted-foreground">
            The newest 50 notifications for your dashboard account.
          </p>

        {items.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 rounded-xl border border-dashed border-border/70 bg-card/40 px-4 py-12 text-center">
            <Inbox className="size-5 text-muted-foreground" />
            <span className="text-sm font-semibold">Nothing yet</span>
            <span className="max-w-sm text-xs text-muted-foreground">
              Messages sent by an owner or admin will appear here no matter
              which dashboard app you are using.
            </span>
          </div>
        ) : (
          <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60 bg-card">
            {items.map((item) => {
              const spec = isStaffNotificationKind(item.kind)
                ? STAFF_NOTIFICATION_KINDS[item.kind]
                : null;
              const content = (
                <>
                  <span
                    aria-hidden
                    className={cn(
                      "mt-1.5 size-1.5 shrink-0 rounded-full",
                      item.readAt ? "bg-transparent" : "bg-cyan-500",
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span
                        className={cn(
                          "truncate text-sm",
                          item.readAt ? "font-medium" : "font-semibold",
                        )}
                      >
                        {item.title}
                      </span>
                      {spec && (
                        <span className="shrink-0 rounded-sm border border-border/60 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground">
                          {spec.label}
                        </span>
                      )}
                    </span>
                    {item.body && (
                      <span className="mt-0.5 block whitespace-pre-wrap text-xs text-muted-foreground">
                        {item.body}
                      </span>
                    )}
                  </span>
                  <span
                    className="shrink-0 text-[11px] text-muted-foreground"
                    title={formatDateTime(item.createdAt)}
                  >
                    {formatRelative(item.createdAt)}
                  </span>
                </>
              );
              const className = cn(
                "flex items-start gap-3 px-3 py-3 sm:px-4",
                !item.readAt && "bg-cyan-500/[0.04]",
                item.href && "transition-colors hover:bg-accent/50",
              );

              return (
                <li key={item.id}>
                  {item.href ? (
                    <HostLink href={item.href} className={className}>
                      {content}
                    </HostLink>
                  ) : (
                    <div className={className}>{content}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function PageSkeleton({ canManage }: { canManage: boolean }) {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <Skeleton key={index} className="h-24 rounded-2xl" />
        ))}
      </div>
      {canManage && <Skeleton className="h-[34rem] rounded-xl" />}
      <div className="space-y-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
    </div>
  );
}
