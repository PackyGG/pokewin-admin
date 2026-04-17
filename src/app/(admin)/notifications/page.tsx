import { AlertTriangle, Bell } from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { KpiTile, PageHero } from "@/components/modern-panels";
import {
  NOTIFICATION_EVENTS,
  getAllNotificationConfigs,
} from "@/lib/queries/notifications";
import { formatRelative } from "@/lib/utils/format";
import {
  NotificationsForm,
  getEventAccent,
  getEventIcon,
  getEventLabel,
} from "./notifications-form";

export const metadata = { title: "Notifications" };

export default async function NotificationsPage() {
  await requirePageAccess("/notifications");

  // Returns null if the admin_db table hasn't been migrated yet — we
  // fall through to a friendly banner rather than crashing the page.
  const configs = await getAllNotificationConfigs();

  if (!configs) {
    return (
      <div className="space-y-6">
        <Hero />
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-5">
          <div className="flex items-start gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl bg-amber-500/20">
              <AlertTriangle className="size-5 text-amber-500" />
            </div>
            <div className="space-y-1">
              <h2 className="text-sm font-semibold">Migration required</h2>
              <p className="text-xs text-muted-foreground">
                The <code>notification_configs</code> table is not present on
                the admin database yet. Apply the migration at{" "}
                <code>
                  prisma/admin/migrations/20260418000001_notification_configs/
                </code>{" "}
                to enable this page.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Hero />

      {/* Per-event status strip. Each tile mirrors the matching config
          card below so the page gives a quick health overview at a
          glance without having to scroll. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {NOTIFICATION_EVENTS.map((event) => {
          const config = configs.find((c) => c.eventType === event);
          const Icon = getEventIcon(event);
          const enabled = config?.enabled ?? false;
          const configured =
            (config?.hasToken ?? false) && (config?.hasChatId ?? false);

          const status = !configured
            ? "Not configured"
            : enabled
              ? "Enabled"
              : "Disabled";

          const sub = config?.updatedAt && config.updatedAt.getTime() > 0
            ? `Updated ${formatRelative(config.updatedAt)}`
            : "Never saved";

          return (
            <KpiTile
              key={event}
              label={getEventLabel(event)}
              value={status}
              sub={sub}
              icon={Icon}
              accent={getEventAccent(event)}
            />
          );
        })}
      </div>

      <NotificationsForm configs={configs} />
    </div>
  );
}

function Hero() {
  return (
    <PageHero>
      <div className="flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
          <Bell className="size-5 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-bold leading-tight">Notifications</h1>
          <p className="text-sm text-muted-foreground">
            Forward platform events to Telegram. Configure a bot + chat id
            per event and toggle each channel on when you&apos;re ready.
          </p>
        </div>
      </div>
    </PageHero>
  );
}
