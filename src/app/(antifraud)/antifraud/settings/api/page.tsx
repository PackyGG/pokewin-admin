import { Braces, Check, LockKeyhole, RadioTower, X } from "lucide-react";

import { requireAntifraudManagerPage } from "@/lib/require-antifraud-access";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { cn } from "@/lib/utils";

export const metadata = { title: "Antifraud API" };

type Method = "GET" | "POST" | "PUT" | "WS";
type Endpoint = {
  method: Method;
  path: string;
  purpose: string;
  auth: string;
};

const SERVICE_ENDPOINTS: readonly Endpoint[] = [
  { method: "GET", path: "/health", purpose: "Process liveness probe.", auth: "Public" },
  { method: "GET", path: "/ready", purpose: "Source and antifraud database readiness.", auth: "Public" },
  { method: "GET", path: "/v1/monitors/live", purpose: "Current three-minute behavior-monitor sessions.", auth: "Bearer service token" },
  { method: "GET", path: "/v1/cases?status=&limit=", purpose: "Risk-ordered case list with subject summaries.", auth: "Bearer service token" },
  { method: "GET", path: "/v1/cases/:id", purpose: "Case, events, provider checks, sessions and staff actions.", auth: "Bearer service token" },
  { method: "GET", path: "/v1/rules", purpose: "All configured behavior-flow rules.", auth: "Bearer service token" },
  { method: "PUT", path: "/v1/rules/:id", purpose: "Update a rule and broadcast the change live.", auth: "Bearer service token" },
  { method: "POST", path: "/v1/cases/:id/decision", purpose: "Record an analyst decision and publish it live.", auth: "Bearer service token" },
  { method: "GET", path: "/v1/top-rain?limit=", purpose: "Top rain winners from the source database.", auth: "Bearer service token" },
  { method: "POST", path: "/v1/ws/tickets", purpose: "Create a 30-second, single-use live-stream ticket.", auth: "Bearer service token" },
  { method: "WS", path: "/v1/live?ticket=", purpose: "Live signup, monitor, rule and case events.", auth: "Single-use Redis ticket" },
];

const DASHBOARD_ENDPOINTS: readonly Endpoint[] = [
  { method: "GET", path: "/api/antifraud/monitor", purpose: "Authenticated live-session and recent-case snapshot bridge.", auth: "Dashboard session" },
  { method: "GET", path: "/api/antifraud/monitor/stream", purpose: "Authenticated WebSocket-to-SSE live bridge.", auth: "Dashboard session" },
  { method: "GET", path: "/api/antifraud/ingest", purpose: "Legacy ingest configuration health probe.", auth: "Public status only" },
  { method: "POST", path: "/api/antifraud/ingest", purpose: "Legacy signed event ingest into the dashboard database.", auth: "HMAC signature" },
  { method: "GET", path: "/api/antifraud/stream", purpose: "Legacy authenticated WebSocket-to-SSE bridge.", auth: "Dashboard session" },
];

export default async function AntifraudApiPage() {
  await requireAntifraudManagerPage();
  const serviceConfigured = Boolean(
    process.env.ANTIFRAUD_MONITOR_API_URL &&
      process.env.ANTIFRAUD_MONITOR_API_TOKEN,
  );

  return (
    <div className="space-y-8">
      <PageHero>
        <PageHeroIdentity
          icon={Braces}
          accent="blue"
          title="Antifraud API"
          subtitle="Every currently deployed monitor and dashboard endpoint"
          backHref="/antifraud"
        />
      </PageHero>

      <div className="flex items-start gap-3 rounded-xl border border-border/60 bg-card px-4 py-3">
        <span
          className={cn(
            "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-lg",
            serviceConfigured
              ? "bg-emerald-500/10 text-emerald-500"
              : "bg-rose-500/10 text-rose-500",
          )}
        >
          {serviceConfigured ? <Check className="size-3.5" /> : <X className="size-3.5" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">Dedicated monitor service</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {serviceConfigured
              ? "The dashboard has its server-only service URL and token."
              : "The dashboard service URL or token is missing."}
          </span>
        </span>
        <span
          className={cn(
            "text-[10px] font-bold uppercase tracking-wide",
            serviceConfigured
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-rose-600 dark:text-rose-400",
          )}
        >
          {serviceConfigured ? "Configured" : "Not configured"}
        </span>
      </div>

      <EndpointSection
        icon={RadioTower}
        title="Dedicated monitor service"
        description="Direct service routes. The bearer token stays server-side; browsers use the dashboard bridges below."
        endpoints={SERVICE_ENDPOINTS}
      />

      <EndpointSection
        icon={LockKeyhole}
        title="Dashboard bridges"
        description="Same-origin routes exposed by the admin dashboard. The monitor pair is current; routes marked legacy belong to the earlier dashboard integration."
        endpoints={DASHBOARD_ENDPOINTS}
      />

      <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs text-muted-foreground">
        Case details, rule editing, decisions and top-rain do not yet have
        dashboard bridge routes. They remain service-only until a manager-gated
        bridge and matching audit policy are added.
      </div>
    </div>
  );
}

function EndpointSection({
  icon,
  title,
  description,
  endpoints,
}: {
  icon: React.ElementType;
  title: string;
  description: string;
  endpoints: readonly Endpoint[];
}) {
  return (
    <section className="space-y-4">
      <SectionHeading icon={icon} title={title} />
      <p className="text-xs text-muted-foreground">{description}</p>
      <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60 bg-card">
        {endpoints.map((endpoint) => (
          <li
            key={`${endpoint.method}-${endpoint.path}`}
            className="grid gap-2 px-4 py-3 md:grid-cols-[3.5rem_minmax(12rem,1fr)_minmax(14rem,1.5fr)_10rem] md:items-center"
          >
            <MethodBadge method={endpoint.method} />
            <code className="break-all font-mono text-xs font-semibold">{endpoint.path}</code>
            <span className="text-xs text-muted-foreground">{endpoint.purpose}</span>
            <span className="text-[11px] text-muted-foreground md:text-right">{endpoint.auth}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function MethodBadge({ method }: { method: Method }) {
  return (
    <span
      className={cn(
        "w-fit rounded-md px-1.5 py-0.5 font-mono text-[10px] font-bold",
        method === "GET" && "bg-blue-500/10 text-blue-600 dark:text-blue-400",
        method === "POST" && "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
        method === "PUT" && "bg-amber-500/10 text-amber-600 dark:text-amber-400",
        method === "WS" && "bg-purple-500/10 text-purple-600 dark:text-purple-400",
      )}
    >
      {method}
    </span>
  );
}
