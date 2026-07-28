import { Suspense } from "react";
import {
  CheckCircle2,
  CircleAlert,
  ListTree,
  Route,
  Webhook,
} from "lucide-react";

import { KpiTile, SectionHeading } from "@/components/modern-panels";
import { getAntifraudNotificationRoutes } from "@/lib/antifraud/monitor-api";
import { requireAntifraudManagerPage } from "@/lib/require-antifraud-access";
import { cn } from "@/lib/utils";

export const metadata = { title: "Webhooks · Antifraud" };

async function WebhookRouteList() {
  const runtime = await getAntifraudNotificationRoutes();
  const routes = runtime.data?.routes ?? [];
  const configured = routes.filter((route) => route.configured).length;
  const eventFamilies = routes.reduce(
    (total, route) => total + route.eventFamilies.length,
    0,
  );

  if (!runtime.configured || runtime.error || routes.length === 0) {
    return (
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-4 text-sm text-amber-800 dark:text-amber-200">
        <div className="flex items-start gap-3">
          <CircleAlert className="mt-0.5 size-5 shrink-0" aria-hidden />
          <div>
            <p className="font-semibold">Route registry unavailable</p>
            <p className="mt-1 text-amber-700 dark:text-amber-300">
              The monitor did not return its notification registry. No route
              or event mapping is being guessed.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-3">
        <KpiTile
          label="Routes"
          value={String(routes.length)}
          icon={Route}
          accent="cyan"
        />
        <KpiTile
          label="Configured"
          value={`${configured}/${routes.length}`}
          icon={CheckCircle2}
          accent={configured === routes.length ? "emerald" : "amber"}
        />
        <KpiTile
          label="Event families"
          value={String(eventFamilies)}
          icon={ListTree}
          accent="purple"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {routes.map((route) => (
          <article
            key={route.label}
            className="rounded-xl border bg-card p-4 shadow-sm sm:p-5"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h2 className="font-semibold text-foreground">{route.label}</h2>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">
                  {route.purpose}
                </p>
              </div>
              <span
                className={cn(
                  "shrink-0 rounded-full border px-2.5 py-1 text-xs font-semibold",
                  route.configured
                    ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                    : "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300",
                )}
              >
                {route.configured ? "Configured" : "Missing"}
              </span>
            </div>

            <div className="mt-4 border-t pt-4">
              <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                Events sent
              </p>
              <ul className="mt-2 space-y-2">
                {route.eventFamilies.map((eventFamily) => (
                  <li
                    key={eventFamily}
                    className="flex gap-2 text-sm text-foreground"
                  >
                    <span
                      className="mt-2 size-1.5 shrink-0 rounded-full bg-cyan-500"
                      aria-hidden
                    />
                    <span>{eventFamily}</span>
                  </li>
                ))}
              </ul>
            </div>
          </article>
        ))}
      </div>
    </>
  );
}

function WebhookRouteFallback() {
  return (
    <div className="grid gap-4 lg:grid-cols-2" aria-label="Loading webhooks">
      {Array.from({ length: 6 }, (_, index) => (
        <div
          key={index}
          className="h-52 animate-pulse rounded-xl border bg-muted/35"
        />
      ))}
    </div>
  );
}

export default async function WebhooksPage() {
  await requireAntifraudManagerPage();

  return (
    <div className="space-y-6">
      <div>
        <SectionHeading icon={Webhook} title="Webhooks" />
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
          Live notification routes and the event families each producer sends.
          Delivery credentials stay sealed in the monitor.
        </p>
      </div>
      <Suspense fallback={<WebhookRouteFallback />}>
        <WebhookRouteList />
      </Suspense>
    </div>
  );
}
