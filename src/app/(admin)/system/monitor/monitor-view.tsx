"use client";

import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Bell,
  CheckCircle2,
  Clock,
  Database,
  Gauge,
  Hourglass,
  Plug,
  Route,
  Server,
  Settings2,
  Timer,
  XCircle,
} from "lucide-react";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
  KpiTile,
  StatPanel,
  PanelRow,
  type AccentColor,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/copy-button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime, formatNumber, formatRelative } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { MonitorRefreshButton } from "./refresh-button";
import type {
  MonitorNotificationSource,
  MonitorOverview,
  MonitorResult,
} from "@/lib/backend-api/monitor";

// ─── Formatting helpers ───────────────────────────────────────────

/** "11m 25s" / "3h 5m" / "2d 4h" from a seconds count. */
function formatUptime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.floor(seconds);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

/** "1,000 ms" with a parenthetical seconds form for sub-/multi-second values.
 *  Uses the app's en-US `formatNumber` so the thousands separator is
 *  deterministic regardless of the server/runtime locale. */
function formatPollInterval(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms >= 1000) return `${formatNumber(ms)} ms (${(ms / 1000).toFixed(1)}s)`;
  return `${formatNumber(ms)} ms`;
}

/**
 * The freshness timestamps look like Postgres `timestamp` WITHOUT timezone
 * ("2026-06-14 09:28:59.683226") — parse them as UTC so the relative age is
 * correct regardless of the server's local zone. A value that already carries
 * a zone (trailing Z / ±hh:mm) or is ISO is passed straight through.
 */
function parseUtcTimestamp(raw: string): Date | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(trimmed);
  // Space-separated "YYYY-MM-DD HH:MM:SS[.ffffff]" → ISO with explicit UTC.
  const normalized = hasZone
    ? trimmed
    : `${trimmed.replace(" ", "T")}${trimmed.includes("T") ? "" : ""}Z`;
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ─── Status → color mapping (infra health, NOT money House-POV) ───

type StatusTone = "good" | "bad" | "warn" | "neutral";

const TONE_BADGE: Record<StatusTone, string> = {
  good: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  bad: "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30",
  warn: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
  neutral: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
};

const TONE_ACCENT: Record<StatusTone, AccentColor> = {
  good: "emerald",
  bad: "rose",
  warn: "amber",
  neutral: "blue",
};

/** "up"/"ok"/"healthy"/"reachable" → good; "down"/"error"/"unreachable" → bad. */
function toneForDependency(status: string): StatusTone {
  const v = status.toLowerCase();
  if (["up", "ok", "healthy", "online", "connected", "reachable"].includes(v))
    return "good";
  if (
    ["down", "error", "fail", "failed", "offline", "unreachable", "disconnected"].includes(
      v,
    )
  )
    return "bad";
  return "warn";
}

function boolTone(value: boolean | null | undefined): StatusTone {
  if (value === true) return "good";
  if (value === false) return "bad";
  return "neutral";
}

function StatusBadge({
  tone,
  children,
}: {
  tone: StatusTone;
  children: React.ReactNode;
}) {
  const Icon =
    tone === "good" ? CheckCircle2 : tone === "bad" ? XCircle : AlertTriangle;
  return (
    <Badge variant="outline" className={cn("gap-1", TONE_BADGE[tone])}>
      <Icon className="size-3" aria-hidden />
      {children}
    </Badge>
  );
}

function BoolBadge({
  value,
  yes = "Yes",
  no = "No",
  unknown = "Unknown",
}: {
  value: boolean | null | undefined;
  yes?: string;
  no?: string;
  unknown?: string;
}) {
  const tone = boolTone(value);
  return (
    <StatusBadge tone={tone}>
      {value === true ? yes : value === false ? no : unknown}
    </StatusBadge>
  );
}

// Freshness staleness thresholds (ms). Documented inline on the page.
const FRESH_OK_MS = 10 * 60 * 1000; // < 10 min → fresh (emerald)
const FRESH_WARN_MS = 2 * 60 * 60 * 1000; // < 2h → ageing (amber); older → stale (rose)

function freshnessTone(ageMs: number): StatusTone {
  if (ageMs < FRESH_OK_MS) return "good";
  if (ageMs < FRESH_WARN_MS) return "warn";
  return "bad";
}

// ─── Top-level view (handles every MonitorResult variant) ─────────

export function MonitorView({
  result,
  fetchedAt,
}: {
  result: MonitorResult;
  fetchedAt: string;
}) {
  if (result.status === "unconfigured") {
    return <UnconfiguredState missing={result.missing} fetchedAt={fetchedAt} />;
  }
  if (result.status === "error") {
    return (
      <ErrorState
        httpStatus={result.httpStatus}
        message={result.message}
        fetchedAt={fetchedAt}
      />
    );
  }
  return (
    <OkState data={result.data} parsedLoosely={result.parsedLoosely} fetchedAt={fetchedAt} />
  );
}

// ─── Shared "last fetched" footer line ────────────────────────────

function LastFetched({ fetchedAt }: { fetchedAt: string }) {
  return (
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Clock className="size-3.5" aria-hidden />
      {/* `fetchedAt` is the server fetch instant (near-now) — its relative
          label flips direction across hydration, so suppress the warning on
          just the relative span. The absolute time beside it is stable. */}
      Last fetched{" "}
      <span suppressHydrationWarning>{formatRelative(fetchedAt)}</span> ·{" "}
      <span className="tabular-nums">{formatDateTime(fetchedAt)}</span>
    </p>
  );
}

// ─── Empty state: env not configured ──────────────────────────────

function UnconfiguredState({
  missing,
  fetchedAt,
}: {
  missing: string[];
  fetchedAt: string;
}) {
  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Activity}
          accent="amber"
          title="Monitor"
          subtitle="Backend monitor service — health, notifications & analytics freshness."
          action={<MonitorRefreshButton />}
        />
      </PageHero>

      <FadeIn>
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-6">
          <div className="flex items-start gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 ring-1 ring-amber-500/30">
              <Settings2 className="size-5 text-amber-500" />
            </div>
            <div className="space-y-2">
              <h2 className="text-base font-semibold tracking-tight">
                Monitor not configured
              </h2>
              <p className="text-sm text-muted-foreground">
                The backend monitor connection isn&apos;t set up in this
                environment, so there&apos;s nothing to display yet. Add the
                following environment variable
                {missing.length === 1 ? "" : "s"} to the Vercel project{" "}
                <span className="font-mono text-foreground">
                  packy-admin-dashboard
                </span>{" "}
                (Production), then redeploy:
              </p>
              <ul className="space-y-1">
                {(missing.length > 0
                  ? missing
                  : ["MONITOR_API_URL", "MONITOR_API_TOKEN"]
                ).map((key) => (
                  <li key={key}>
                    <Badge
                      variant="outline"
                      className="gap-1 font-mono text-amber-600 dark:text-amber-400"
                    >
                      <XCircle className="size-3" aria-hidden />
                      {key}
                    </Badge>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">
                <span className="font-mono">MONITOR_API_URL</span> is the
                monitor service base URL; the request reads{" "}
                <span className="font-mono">/v1/admin/overview</span> with{" "}
                <span className="font-mono">MONITOR_API_TOKEN</span> as a bearer
                token. The token is read server-side only and is never exposed
                to the browser.
              </p>
            </div>
          </div>
        </div>
      </FadeIn>

      <LastFetched fetchedAt={fetchedAt} />
    </div>
  );
}

// ─── Error state: fetch failed / non-200 / bad JSON ───────────────

function ErrorState({
  httpStatus,
  message,
  fetchedAt,
}: {
  httpStatus: number | null;
  message: string;
  fetchedAt: string;
}) {
  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Activity}
          accent="rose"
          title="Monitor"
          subtitle="Backend monitor service — health, notifications & analytics freshness."
          action={<MonitorRefreshButton />}
        />
      </PageHero>

      <FadeIn>
        <div className="rounded-2xl border border-rose-500/30 bg-rose-500/5 p-6">
          <div className="flex items-start gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-rose-500/10 ring-1 ring-rose-500/30">
              <AlertTriangle className="size-5 text-rose-500" />
            </div>
            <div className="flex-1 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold tracking-tight">
                  Couldn&apos;t load the monitor
                </h2>
                {httpStatus != null && (
                  <Badge
                    variant="outline"
                    className="gap-1 font-mono text-rose-600 dark:text-rose-400"
                  >
                    HTTP {httpStatus}
                  </Badge>
                )}
              </div>
              <p className="text-sm text-muted-foreground">{message}</p>
              <p className="text-xs text-muted-foreground">
                The data was not loaded — this is a connection/response problem
                with the monitor service, not a sign that anything in it is
                down. Use Refresh to retry.
              </p>
              <div className="flex items-center gap-2 pt-1">
                <MonitorRefreshButton />
                <Button
                  variant="outline"
                  size="sm"
                  nativeButton={false}
                  render={<Link href="/dashboard" />}
                >
                  <ArrowLeft className="size-4" aria-hidden />
                  Back to dashboard
                </Button>
              </div>
            </div>
          </div>
        </div>
      </FadeIn>

      <LastFetched fetchedAt={fetchedAt} />
    </div>
  );
}

// ─── Success state: render everything ─────────────────────────────

function OkState({
  data,
  parsedLoosely,
  fetchedAt,
}: {
  data: MonitorOverview;
  parsedLoosely: boolean;
  fetchedAt: string;
}) {
  const service = data.service ?? null;
  const notifications = data.notifications ?? null;
  const analytics = data.analytics ?? null;
  const dependencies = data.dependencies ?? null;

  const depEntries = dependencies ? Object.entries(dependencies) : [];
  // Overall health: every dependency "up" → healthy; any not up → degraded.
  const anyDepDown = depEntries.some(([, v]) => toneForDependency(v) !== "good");
  const overallTone: StatusTone =
    depEntries.length === 0 ? "neutral" : anyDepDown ? "bad" : "good";

  const freshnessEntries = analytics?.freshness
    ? Object.entries(analytics.freshness)
    : [];
  const sources = notifications?.sources ?? [];

  return (
    <div className="space-y-6">
      {/* ── Hero + health summary ───────────────────────────────── */}
      <PageHero>
        <PageHeroIdentity
          icon={Activity}
          accent={TONE_ACCENT[overallTone]}
          title={
            <span className="flex flex-wrap items-center gap-2">
              Monitor
              {service?.name && (
                <span className="font-mono text-sm font-normal text-muted-foreground">
                  {service.name}
                </span>
              )}
            </span>
          }
          subtitle="Backend monitor service — health, notifications & analytics freshness."
          badges={
            <StatusBadge tone={overallTone}>
              {overallTone === "good"
                ? "All systems healthy"
                : overallTone === "bad"
                  ? "Degraded"
                  : "Status unknown"}
            </StatusBadge>
          }
          action={<MonitorRefreshButton />}
        />

        {/* KPI strip */}
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
          <KpiTile
            label="Postgres"
            value={depStatusText(dependencies?.postgres)}
            icon={Database}
            accent={TONE_ACCENT[depTone(dependencies?.postgres)]}
          />
          <KpiTile
            label="ClickHouse"
            value={depStatusText(dependencies?.clickhouse)}
            icon={Database}
            accent={TONE_ACCENT[depTone(dependencies?.clickhouse)]}
          />
          <KpiTile
            label="Uptime"
            value={formatUptime(service?.uptime_seconds)}
            icon={Timer}
            accent="blue"
          />
          <KpiTile
            label="Poll interval"
            value={
              service?.poll_interval_ms != null
                ? `${formatNumber(service.poll_interval_ms)} ms`
                : "—"
            }
            icon={Gauge}
            accent="cyan"
          />
          <KpiTile
            label="Node"
            value={service?.node ?? "—"}
            icon={Server}
            accent="purple"
          />
          <KpiTile
            label="Analytics"
            value={
              analytics?.reachable === true
                ? "Reachable"
                : analytics?.reachable === false
                  ? "Unreachable"
                  : "Unknown"
            }
            icon={Activity}
            accent={TONE_ACCENT[boolTone(analytics?.reachable)]}
          />
        </div>
      </PageHero>

      {parsedLoosely && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
          <p className="text-xs text-muted-foreground">
            The monitor returned data in an unexpected shape, so some fields may
            be displayed loosely. The raw values are still shown below where
            possible.
          </p>
        </div>
      )}

      {/* ── Service + Dependencies ──────────────────────────────── */}
      <FadeIn>
        <div className="space-y-4">
          <SectionHeading icon={Server} title="Service" />
          <div className="grid gap-4 lg:grid-cols-2">
            <StatPanel title="Process" icon={Server} accent="blue">
              <div className="divide-y divide-border/60">
                <PanelRow
                  label="Name"
                  value={
                    service?.name ? (
                      <span className="font-mono">{service.name}</span>
                    ) : (
                      "—"
                    )
                  }
                />
                <PanelRow
                  label="Node version"
                  value={
                    service?.node ? (
                      <span className="font-mono">{service.node}</span>
                    ) : (
                      "—"
                    )
                  }
                />
                <PanelRow
                  label="Uptime"
                  value={formatUptime(service?.uptime_seconds)}
                />
                <PanelRow
                  label="Poll interval"
                  value={formatPollInterval(service?.poll_interval_ms)}
                />
                <PanelRow
                  label="Reported at"
                  value={
                    service?.ts ? (
                      // The monitor's `ts` is its own "now" — a near-current
                      // instant. A relative label ("X ago"/"in X") flips
                      // direction across the SSR→hydration boundary for a
                      // near-now value, so render the stable ABSOLUTE time
                      // here (the relative "Last fetched" line below already
                      // gives recency context).
                      <span className="tabular-nums" title={service.ts}>
                        {formatDateTime(asUtc(service.ts))}
                      </span>
                    ) : (
                      "—"
                    )
                  }
                />
              </div>
            </StatPanel>

            <StatPanel title="Dependencies" icon={Plug} accent={TONE_ACCENT[overallTone]}>
              {depEntries.length === 0 ? (
                <p className="py-2 text-sm text-muted-foreground">
                  No dependencies reported.
                </p>
              ) : (
                <div className="space-y-2">
                  {depEntries.map(([name, status]) => (
                    <div
                      key={name}
                      className="flex items-center justify-between gap-3 py-1"
                    >
                      <span className="flex min-w-0 items-center gap-2 text-sm">
                        <Database className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate capitalize">{name}</span>
                      </span>
                      <StatusBadge tone={toneForDependency(status)}>
                        {status}
                      </StatusBadge>
                    </div>
                  ))}
                </div>
              )}
            </StatPanel>
          </div>
        </div>
      </FadeIn>

      {/* ── Notifications ───────────────────────────────────────── */}
      <FadeIn>
        <div className="space-y-4">
          <SectionHeading icon={Bell} title="Notifications" />
          <StatPanel
            title={
              <span className="flex flex-wrap items-center gap-2">
                Provider
                {notifications?.provider && (
                  <span className="font-mono text-foreground">
                    {notifications.provider}
                  </span>
                )}
              </span>
            }
            icon={Bell}
            accent="cyan"
            action={
              <BoolBadge
                value={notifications?.auth}
                yes="Auth on"
                no="Auth off"
              />
            }
          >
            <div className="mb-4 grid gap-x-6 gap-y-1 sm:grid-cols-2">
              <PanelRow label="Provider" value={notifications?.provider ?? "—"} />
              <PanelRow
                label="Topic"
                value={
                  notifications?.topic ? (
                    <span className="font-mono">{notifications.topic}</span>
                  ) : (
                    "—"
                  )
                }
              />
              <PanelRow
                label="Server"
                value={
                  notifications?.server ? (
                    <span className="font-mono">{notifications.server}</span>
                  ) : (
                    "—"
                  )
                }
              />
              <PanelRow
                label="Authenticated"
                value={
                  <BoolBadge value={notifications?.auth} />
                }
              />
            </div>

            {sources.length > 0 ? (
              <div className="rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Source</TableHead>
                      <TableHead>Title</TableHead>
                      <TableHead>Table</TableHead>
                      <TableHead>Filter</TableHead>
                      <TableHead>Last seen</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sources.map((src, i) => (
                      <SourceRow key={src.name ?? i} src={src} />
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <p className="py-2 text-sm text-muted-foreground">
                No notification sources reported.
              </p>
            )}
          </StatPanel>
        </div>
      </FadeIn>

      {/* ── Analytics ───────────────────────────────────────────── */}
      <FadeIn>
        <div className="space-y-4">
          <SectionHeading icon={Database} title="Analytics" />

          <div className="flex flex-wrap items-center gap-2">
            {analytics?.store && (
              <Badge variant="outline" className="gap-1">
                <Database className="size-3" aria-hidden />
                <span className="font-mono">{analytics.store}</span>
              </Badge>
            )}
            {analytics?.database && (
              <Badge variant="outline" className="gap-1">
                db: <span className="font-mono">{analytics.database}</span>
              </Badge>
            )}
            <StatusBadge tone={boolTone(analytics?.configured)}>
              {analytics?.configured === false ? "Not configured" : "Configured"}
            </StatusBadge>
            <StatusBadge tone={boolTone(analytics?.reachable)}>
              {analytics?.reachable === false ? "Unreachable" : "Reachable"}
            </StatusBadge>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            {/* Freshness */}
            <StatPanel title="Data freshness" icon={Hourglass} accent="amber">
              {freshnessEntries.length === 0 ? (
                <p className="py-2 text-sm text-muted-foreground">
                  No freshness data reported.
                </p>
              ) : (
                <>
                  <div className="rounded-lg border">
                    <Table>
                      <TableHeader>
                        <TableRow className="hover:bg-transparent">
                          <TableHead>Stream</TableHead>
                          <TableHead>Last record</TableHead>
                          <TableHead className="text-right">Age</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {freshnessEntries.map(([key, ts]) => (
                          <FreshnessRow key={key} streamKey={key} ts={ts} />
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    Age thresholds: &lt; 10 min fresh, &lt; 2 h ageing, older is
                    stale. Timestamps are read as UTC.
                  </p>
                </>
              )}
            </StatPanel>

            {/* Endpoints */}
            <StatPanel title="Monitored endpoints" icon={Route} accent="purple">
              {analytics?.endpoints && analytics.endpoints.length > 0 ? (
                <ul className="space-y-1.5">
                  {analytics.endpoints.map((ep) => (
                    <li
                      key={ep}
                      className="flex items-center gap-2 rounded-md border bg-muted/30 px-2.5 py-1.5"
                    >
                      <Route
                        className="size-3.5 shrink-0 text-muted-foreground"
                        aria-hidden
                      />
                      <code className="truncate text-xs">{ep}</code>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="py-2 text-sm text-muted-foreground">
                  No endpoints reported.
                </p>
              )}
            </StatPanel>
          </div>
        </div>
      </FadeIn>

      <LastFetched fetchedAt={fetchedAt} />
    </div>
  );
}

// ─── Row sub-components ───────────────────────────────────────────

function SourceRow({ src }: { src: MonitorNotificationSource }) {
  const cursor = src.cursor ?? null;
  const cursorTs = cursor?.created_at ?? null;
  const cursorId = cursor?.id ?? null;
  return (
    <TableRow>
      <TableCell className="font-medium capitalize">{src.name ?? "—"}</TableCell>
      <TableCell className="text-muted-foreground">{src.title ?? "—"}</TableCell>
      <TableCell>
        {src.table ? <code className="text-xs">{src.table}</code> : "—"}
      </TableCell>
      <TableCell>
        {src.filter ? (
          <code className="text-xs">{src.filter}</code>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell>
        {cursorTs ? (
          <div className="flex flex-col gap-0.5">
            {/* Relative label can refer to a near-now cursor on an active
                stream → direction flips across hydration; suppress the
                warning (client re-renders the correct value). */}
            <span className="text-xs" title={cursorTs} suppressHydrationWarning>
              {formatRelative(asUtc(cursorTs))}
            </span>
            {cursorId && (
              <span className="flex items-center gap-1">
                <code className="max-w-[140px] truncate text-[10px] text-muted-foreground">
                  {cursorId}
                </code>
                <CopyButton value={cursorId} label="Cursor ID" />
              </span>
            )}
          </div>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
    </TableRow>
  );
}

function FreshnessRow({
  streamKey,
  ts,
}: {
  streamKey: string;
  ts: string | null;
}) {
  const parsed = ts ? parseUtcTimestamp(ts) : null;
  const ageMs = parsed ? Date.now() - parsed.getTime() : null;
  const tone = ageMs != null ? freshnessTone(ageMs) : "neutral";
  return (
    <TableRow>
      <TableCell className="font-medium">
        <span className="capitalize">{streamKey.replace(/_/g, " ")}</span>
      </TableCell>
      <TableCell className="text-muted-foreground">
        {parsed ? (
          <span className="tabular-nums" title={ts ?? undefined}>
            {formatDateTime(parsed)}
          </span>
        ) : (
          (ts ?? "—")
        )}
      </TableCell>
      <TableCell className="text-right">
        {parsed ? (
          // Freshness age is computed from the render clock; a near-now
          // stream (e.g. ledger) flips "ago"/"in" across hydration, so
          // suppress the mismatch warning (client corrects on re-render).
          <span suppressHydrationWarning>
            <StatusBadge tone={tone}>{formatRelative(parsed)}</StatusBadge>
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
    </TableRow>
  );
}

// ─── Small inline helpers ─────────────────────────────────────────

function depTone(status: string | undefined): StatusTone {
  return status ? toneForDependency(status) : "neutral";
}

function depStatusText(status: string | undefined): string {
  if (!status) return "—";
  // Capitalize the reported status ("up" → "Up").
  return status.charAt(0).toUpperCase() + status.slice(1);
}

/** Normalize a bare Postgres timestamp string to a UTC Date (for formatters). */
function asUtc(raw: string): Date {
  return parseUtcTimestamp(raw) ?? new Date(raw);
}
