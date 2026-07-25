import { Suspense } from "react";
import Link from "next/link";
import { Bell, Inbox } from "lucide-react";

import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";
import { safeQuery } from "@/lib/errors/safe-query";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatDateTime, formatRelative } from "@/lib/utils/format";
import {
  STAFF_NOTIFICATION_KINDS,
  countUnreadStaffNotifications,
  isStaffNotificationKind,
  listStaffNotifications,
} from "@/lib/antifraud/notifications";
import { MarkAllButton } from "./_components/mark-all-button";

export const metadata = { title: "Notifications" };

/**
 * Antifraud → Notifications.
 *
 * The full inbox behind the header bell — the bell shows the newest twelve,
 * this shows the history. Read state is per person (a broadcast writes one row
 * each), and marking read only ever touches your own rows.
 */

const QUERY_TIMEOUT_MS = 10_000;

export default async function NotificationsPage() {
  const session = await requireAntifraudPageAccess();

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Bell}
          accent="cyan"
          title="Notifications"
          subtitle="Quiz drops, case assignments and fraud alerts"
          backHref="/antifraud"
        />
      </PageHero>

      <Suspense fallback={<InboxSkeleton />}>
        <InboxList adminUserId={session.userId} />
      </Suspense>
    </div>
  );
}

async function InboxList({ adminUserId }: { adminUserId: string }) {
  const [{ data: items }, { data: unread }] = await Promise.all([
    safeQuery(
      () => listStaffNotifications(adminUserId, 50),
      [],
      "antifraud.notifications-list",
      QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => countUnreadStaffNotifications(adminUserId),
      0,
      "antifraud.notifications-unread",
      QUERY_TIMEOUT_MS,
    ),
  ]);

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-1.5 rounded-xl border border-dashed border-border/70 bg-card/40 px-4 py-12 text-center">
        <Inbox className="size-5 text-muted-foreground" />
        <span className="text-sm font-semibold">Nothing yet</span>
        <span className="max-w-sm text-xs text-muted-foreground">
          When a quiz is published, a case is assigned to you, or a serious
          fraud signal arrives, it lands here — and on Discord or Telegram if
          you set that up on your profile.
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {unread > 0
            ? `${unread} unread of ${items.length} shown`
            : `${items.length} notification${items.length === 1 ? "" : "s"}`}
        </span>
        <MarkAllButton disabled={unread === 0} />
      </div>

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
                  <span className="mt-0.5 block text-xs text-muted-foreground">
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
                <Link href={item.href} className={className}>
                  {content}
                </Link>
              ) : (
                <div className={className}>{content}</div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function InboxSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-8 w-48" />
      <div className="overflow-hidden rounded-xl border border-border/60">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full rounded-none" />
        ))}
      </div>
    </div>
  );
}
