import { Suspense } from "react";
import { BellOff } from "lucide-react";

import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { Skeleton } from "@/components/ui/skeleton";
import { listAntifraudDashboardNotificationRules } from "@/lib/antifraud/dashboard-notification-rules";
import { safeQueryOrNull } from "@/lib/errors/safe-query";
import { requireAntifraudManagerPage } from "@/lib/require-antifraud-access";
import { DashboardNotificationWorkspace } from "./workspace";

export const metadata = { title: "Dashboard Notifications · Antifraud" };

const QUERY_TIMEOUT_MS = 10_000;

export default async function AntifraudNotificationsPage() {
  await requireAntifraudManagerPage();

  // Shell-first (CLAUDE.md § Pflicht: Shell-first Suspense-Streaming). The rule
  // + event read is two Admin-DB round-trips; awaiting it in the page body
  // blocked first paint on them and left the route with no frame of its own.
  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity />
      </PageHero>

      <Suspense fallback={<WorkspaceSkeleton />}>
        <NotificationRulesData />
      </Suspense>
    </div>
  );
}

async function NotificationRulesData() {
  // The underlying reads are raw `adminDrizzle.execute` calls, so a DB fault
  // THROWS and a slow one merely hangs. Unguarded, either one took down the
  // whole route through the segment error boundary. safeQueryOrNull degrades
  // both to a panel while the shell and navigation stay usable.
  const { data: config, kind } = await safeQueryOrNull(
    () => listAntifraudDashboardNotificationRules(),
    "antifraud.dashboard-notification-rules",
    QUERY_TIMEOUT_MS,
  );

  if (!config) {
    return (
      <div
        role="status"
        className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-12 text-center"
      >
        <BellOff className="mx-auto size-6 text-amber-500" aria-hidden />
        <p className="mt-2 text-sm font-semibold text-amber-800 dark:text-amber-200">
          Notification rules are unavailable
        </p>
        <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
          {kind === "timeout"
            ? "The Admin-DB read took too long. Rules already saved keep running on the monitor — refresh to retry."
            : "The Admin-DB read failed. No rules are being shown as empty, and nothing has been changed."}
        </p>
      </div>
    );
  }

  return (
    <DashboardNotificationWorkspace
      initialRules={config.rules}
      events={config.events}
    />
  );
}

function WorkspaceSkeleton() {
  return (
    <div
      className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]"
      aria-label="Loading notification rules"
    >
      <div className="overflow-hidden rounded-xl border border-border/60">
        {Array.from({ length: 5 }).map((_, index) => (
          <Skeleton key={index} className="h-24 w-full rounded-none" />
        ))}
      </div>
      <Skeleton className="h-[520px] rounded-xl" />
    </div>
  );
}
