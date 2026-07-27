import { Activity, Braces, RadioTower, ShieldCheck } from "lucide-react";

import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { requireAntifraudManagerPage } from "@/lib/require-antifraud-access";

export const metadata = { title: "Antifraud API" };

type Endpoint = {
  method: "GET" | "POST" | "PUT" | "WS";
  path: string;
  description: string;
  auth: string;
};

const READ_ENDPOINTS: Endpoint[] = [
  {
    method: "GET",
    path: "/health",
    description: "Liveness and poller status.",
    auth: "Public",
  },
  {
    method: "GET",
    path: "/ready",
    description: "Database and poller readiness.",
    auth: "Bearer read token",
  },
  {
    method: "GET",
    path: "/v1/operations/poller",
    description: "Detailed poller health and leader state.",
    auth: "Bearer read token",
  },
  {
    method: "GET",
    path: "/v1/operations/config",
    description:
      "Sanitized deployed integration presence and compiled Discord recipients. No secrets.",
    auth: "Bearer read token",
  },
  {
    method: "GET",
    path: "/v1/monitors/live",
    description: "Up to 200 active behavior-monitor sessions.",
    auth: "Bearer read token",
  },
  {
    method: "GET",
    path: "/v1/signups?page=&limit=",
    description: "Paginated signup assessments and provider checks.",
    auth: "Bearer read token",
  },
  {
    method: "GET",
    path: "/v1/cases?status=&limit=",
    description: "Bounded case queue, optionally filtered by status.",
    auth: "Bearer read token",
  },
  {
    method: "GET",
    path: "/v1/cases/:id",
    description: "One case with events, checks, sessions and staff actions.",
    auth: "Bearer read token",
  },
  {
    method: "GET",
    path: "/v1/rules",
    description: "Current behavior-rule definitions.",
    auth: "Bearer read token",
  },
  {
    method: "GET",
    path: "/v1/top-rain?limit=",
    description: "Top completed rain winners from the source ledger.",
    auth: "Bearer read token",
  },
  {
    method: "GET",
    path: "/v1/scoring",
    description: "Scoring catalog, severity bands and behavior rules.",
    auth: "Bearer read token",
  },
];

const WRITE_ENDPOINTS: Endpoint[] = [
  {
    method: "PUT",
    path: "/v1/rules/:id",
    description: "Update a rule with an idempotency key.",
    auth: "Bearer admin token",
  },
  {
    method: "POST",
    path: "/v1/cases/:id/decision",
    description: "Record an idempotent staff decision and reason.",
    auth: "Bearer admin token",
  },
];

const LIVE_ENDPOINTS: Endpoint[] = [
  {
    method: "POST",
    path: "/v1/ws/tickets",
    description: "Issue a one-time, 30-second WebSocket ticket.",
    auth: "Bearer read token",
  },
  {
    method: "GET",
    path: "/v1/live/replay?after=&limit=",
    description: "Replay persisted live envelopes after a Redis stream id.",
    auth: "Bearer read token",
  },
  {
    method: "WS",
    path: "/v1/live",
    description: "Live envelopes via the antifraud-ticket.<ticket> subprotocol.",
    auth: "One-time ticket + allowed Origin",
  },
];

const INGEST_ENDPOINTS: Endpoint[] = [
  {
    method: "GET",
    path: "/api/antifraud/ingest",
    description: "Deployment and HMAC-configuration probe.",
    auth: "Public; no secret value returned",
  },
  {
    method: "POST",
    path: "/api/antifraud/ingest",
    description:
      "Persist up to 50 signals. Signs timestamp.rawBody with HMAC-SHA256.",
    auth: "x-antifraud-timestamp + x-antifraud-signature",
  },
];

export default async function AntifraudApiPage() {
  await requireAntifraudManagerPage();

  return (
    <div className="space-y-8">
      <PageHero>
        <PageHeroIdentity
          icon={Braces}
          accent="blue"
          title="Antifraud API"
          subtitle="Current service, live transport and durable ingest contracts"
        />
      </PageHero>

      <EndpointSection icon={Activity} title="Read API" endpoints={READ_ENDPOINTS} />
      <EndpointSection
        icon={ShieldCheck}
        title="Admin mutations"
        endpoints={WRITE_ENDPOINTS}
      />
      <EndpointSection
        icon={RadioTower}
        title="Live transport"
        endpoints={LIVE_ENDPOINTS}
      />
      <EndpointSection
        icon={Braces}
        title="Dashboard ingest"
        endpoints={INGEST_ENDPOINTS}
      />
    </div>
  );
}

function EndpointSection({
  icon,
  title,
  endpoints,
}: {
  icon: React.ElementType;
  title: string;
  endpoints: Endpoint[];
}) {
  return (
    <section className="space-y-4">
      <SectionHeading icon={icon} title={title} />
      <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60 bg-card">
        {endpoints.map((endpoint) => (
          <li
            key={`${endpoint.method}:${endpoint.path}`}
            className="grid gap-2 px-4 py-3 md:grid-cols-[3.5rem_minmax(12rem,1fr)_minmax(14rem,1.5fr)_12rem] md:items-center"
          >
            <MethodBadge method={endpoint.method} />
            <code className="break-all font-mono text-xs font-semibold">
              {endpoint.path}
            </code>
            <span className="text-xs text-muted-foreground">
              {endpoint.description}
            </span>
            <span className="text-[11px] text-muted-foreground md:text-right">
              {endpoint.auth}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function MethodBadge({ method }: { method: Endpoint["method"] }) {
  const classes =
    method === "GET"
      ? "bg-blue-500/10 text-blue-600 dark:text-blue-400"
      : method === "WS"
        ? "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400"
        : "bg-amber-500/10 text-amber-700 dark:text-amber-300";
  return (
    <span
      className={`w-fit rounded-md px-1.5 py-0.5 font-mono text-[10px] font-bold ${classes}`}
    >
      {method}
    </span>
  );
}
