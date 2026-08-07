import {
  Activity,
  BellRing,
  CircleAlert,
  Crown,
  Gauge,
  RadioTower,
  TimerReset,
} from "lucide-react";

import { KpiTile, SectionHeading } from "@/components/modern-panels";
import { Badge } from "@/components/ui/badge";
import {
  getAntifraudNotificationRoutes,
  getAntifraudPollerHealth,
  getAntifraudRuntimeConfig,
  type AntifraudPollerHealth,
} from "@/lib/antifraud/monitor-api";
import { getSignupIngestionFailures } from "@/lib/antifraud/signup-failures-api";
import { cn } from "@/lib/utils";
import { formatDateTime, formatRelative } from "@/lib/utils/format";
import { SignupFailureManager } from "../_components/signup-failure-manager";

/**
 * ENGINE HEALTH — the monitor's own runtime state.
 *
 * The monitor has reported poller health and notification-route wiring for a
 * while, but nothing in the dashboard rendered it: a stalled ingestion loop or
 * an unconfigured alert family was only visible by noticing that cases had
 * stopped arriving. This section surfaces both, and the Automation overview
 * folds the same reads into its ranked issue list.
 */
export async function EngineHealthSection() {
  const [poller, runtime, routes, signupFailures] = await Promise.all([
    getAntifraudPollerHealth(),
    getAntifraudRuntimeConfig(),
    getAntifraudNotificationRoutes(),
    getSignupIngestionFailures(),
  ]);

  if (!poller.configured) {
    return (
      <Unavailable text="The monitor service is not configured, so it reports no health." />
    );
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <SectionHeading icon={Activity} title="Ingestion loop" />
        {poller.error || !poller.data ? (
          <Unavailable text="The monitor did not report its ingestion loop status." />
        ) : (
          <PollerPanel health={poller.data} />
        )}
      </section>

      {signupFailures.configured && !signupFailures.error && (
        <SignupFailureManager failures={signupFailures.data} />
      )}

      <section className="space-y-3">
        <SectionHeading icon={BellRing} title="Alert families" />
        {!routes.configured || routes.error || !routes.data ? (
          <Unavailable text="The monitor did not report its notification routes." />
        ) : routes.data.routes.length === 0 ? (
          <Unavailable text="The monitor reports no notification routes." />
        ) : (
          <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60 bg-card">
            {routes.data.routes.map((route) => (
              <li key={route.label} className="flex items-start gap-3 px-4 py-3">
                <span className="min-w-0 flex-1">
                  <span className="text-sm font-medium">{route.label}</span>
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">
                    {route.purpose}
                  </span>
                  <span className="mt-1.5 flex flex-wrap gap-1">
                    {route.eventFamilies.map((family) => (
                      <code
                        key={family}
                        className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                      >
                        {family}
                      </code>
                    ))}
                  </span>
                </span>
                <Badge
                  variant="outline"
                  className={cn(
                    "shrink-0",
                    route.configured
                      ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400"
                      : "border-amber-500/30 bg-amber-500/5 text-amber-600 dark:text-amber-400",
                  )}
                >
                  {route.configured ? "Configured" : "Not configured"}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </section>

      {runtime.data?.fiatEligibility && (
        <section className="space-y-3">
          <SectionHeading icon={Gauge} title="Fiat eligibility gate" />
          <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60 bg-card">
            {(
              [
                ["Production credential", runtime.data.fiatEligibility.prodCredentialConfigured],
                ["Production IP allowlist", runtime.data.fiatEligibility.prodIpAllowlistConfigured],
                ["Dev credential", runtime.data.fiatEligibility.devCredentialConfigured],
                ["Dev source", runtime.data.fiatEligibility.devSourceConfigured],
                ["Dev IP allowlist", runtime.data.fiatEligibility.devIpAllowlistConfigured],
              ] as const
            ).map(([label, ok]) => (
              <li
                key={label}
                className="flex items-center justify-between gap-3 px-4 py-2.5"
              >
                <span className="min-w-0 truncate text-sm">{label}</span>
                <span
                  className={cn(
                    "shrink-0 text-[10px] font-semibold uppercase tracking-wide",
                    ok
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-muted-foreground",
                  )}
                >
                  {ok ? "Configured" : "Not set"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

const STATUS_ACCENT = {
  healthy: "emerald",
  starting: "amber",
  standby: "blue",
  degraded: "rose",
} as const;

/**
 * "Degraded" is the monitor's word for four different conditions, only two of
 * which are faults. Saying which one is in play here stops this tile from
 * reading as an outage when the loop is ticking cleanly with a queue behind it.
 */
function statusSub(health: AntifraudPollerHealth): string {
  if (health.status === "degraded") {
    if (health.consecutiveFailures > 0) return "Ticks are failing";
    if (health.signupFailuresPending > 0) return "Signups queued for recovery";
    if (health.signupBacklogPossible) return "Cursor is behind new signups";
    return "No recent successful tick";
  }
  return health.running ? "Loop running" : "Loop not running";
}

function PollerPanel({ health }: { health: AntifraudPollerHealth }) {
  const rows: Array<[string, string]> = [
    [
      "Last tick started",
      health.lastTickStartedAt
        ? `${formatRelative(health.lastTickStartedAt)} · ${formatDateTime(health.lastTickStartedAt)}`
        : "Never",
    ],
    [
      "Last tick completed",
      health.lastTickCompletedAt
        ? `${formatRelative(health.lastTickCompletedAt)} · ${formatDateTime(health.lastTickCompletedAt)}`
        : "Never",
    ],
    [
      "Last tick duration",
      health.lastTickDurationMs === null
        ? "—"
        : `${health.lastTickDurationMs.toLocaleString()} ms`,
    ],
    ["Skipped ticks", health.skippedTicks.toLocaleString()],
    ["Signups processed", health.signupsProcessed.toLocaleString()],
    ["Signups recovered", health.signupsRecovered.toLocaleString()],
    ["Signups pending recovery", health.signupFailuresPending.toLocaleString()],
    ["Activities processed", health.activitiesProcessed.toLocaleString()],
    [
      "Signup cursor lag",
      health.signupCursorLagMs === null
        ? "—"
        : `${Math.round(health.signupCursorLagMs / 1000).toLocaleString()}s`,
    ],
    ["Backlog possible", health.signupBacklogPossible ? "Yes" : "No"],
  ];

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile
          label="Status"
          value={health.status[0]!.toUpperCase() + health.status.slice(1)}
          sub={statusSub(health)}
          icon={RadioTower}
          accent={STATUS_ACCENT[health.status]}
        />
        <KpiTile
          label="Role"
          value={health.leader ? "Leader" : "Follower"}
          sub={health.leader ? "Owns the ingestion loop" : "Standing by"}
          icon={Crown}
          accent={health.leader ? "cyan" : "blue"}
        />
        <KpiTile
          label="Last success"
          value={
            health.lastSuccessfulTickAt
              ? formatRelative(health.lastSuccessfulTickAt)
              : "Never"
          }
          sub={
            health.lastSuccessfulTickAt
              ? formatDateTime(health.lastSuccessfulTickAt)
              : "No successful tick recorded"
          }
          icon={TimerReset}
          accent={health.lastSuccessfulTickAt ? "emerald" : "amber"}
        />
        <KpiTile
          label="Consecutive failures"
          value={health.consecutiveFailures.toLocaleString()}
          sub={
            health.consecutiveFailures === 0
              ? "Loop is retrying cleanly"
              : "Ingestion is failing"
          }
          icon={CircleAlert}
          accent={health.consecutiveFailures === 0 ? "emerald" : "rose"}
        />
      </div>

      {health.lastError && (
        <div className="flex gap-3 rounded-xl border border-rose-500/25 bg-rose-500/5 px-4 py-3">
          <CircleAlert
            className="mt-0.5 size-4 shrink-0 text-rose-600 dark:text-rose-400"
            aria-hidden
          />
          <div className="min-w-0">
            <p className="text-xs font-semibold text-rose-700 dark:text-rose-300">
              Last reported error
            </p>
            <p className="mt-0.5 break-words text-xs leading-5 text-muted-foreground">
              {health.lastError}
            </p>
          </div>
        </div>
      )}

      <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60 bg-card">
        {rows.map(([label, value]) => (
          <li
            key={label}
            className="flex items-center justify-between gap-3 px-4 py-2.5"
          >
            <span className="min-w-0 truncate text-sm text-muted-foreground">
              {label}
            </span>
            <span className="shrink-0 text-sm font-medium tabular-nums">
              {value}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Unavailable({ text }: { text: string }) {
  return (
    <div className="rounded-xl border border-dashed border-border/70 bg-card/40 px-4 py-12 text-center">
      <RadioTower
        className="mx-auto mb-3 size-6 text-muted-foreground"
        aria-hidden
      />
      <p className="text-sm text-muted-foreground">{text}</p>
    </div>
  );
}
