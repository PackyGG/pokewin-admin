"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
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
  Info,
  KeyRound,
  Layers,
  Lock,
  Plug,
  Plus,
  Pencil,
  Route,
  Send,
  Server,
  Settings2,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Timer,
  Trash2,
  Unlock,
  XCircle,
  Zap,
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
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
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
import {
  toggleMonitorEvent,
  createApiKey,
  revokeApiKey,
  updateMonitorChannel,
} from "./actions";
import type {
  MonitorOverview,
  MonitorResult,
  AntifraudResult,
  AntifraudSignal,
  MonitorEvent,
  MonitorEventsResult,
  MonitorApiEndpoint,
  MonitorEndpointsResult,
  MonitorApiKey,
  MonitorApiKeysResult,
  CreatedMonitorApiKey,
  MonitorChannel,
  MonitorChannelsResult,
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

/** Human duration from a millisecond count: "30s" / "6h" / "5m". */
function formatMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${formatNumber(ms)} ms`;
  return formatUptime(ms / 1000);
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
  antifraud,
  events,
  endpoints,
  apiKeys,
  channels,
  fetchedAt,
}: {
  result: MonitorResult;
  antifraud: AntifraudResult;
  events: MonitorEventsResult;
  endpoints: MonitorEndpointsResult;
  apiKeys: MonitorApiKeysResult;
  channels: MonitorChannelsResult;
  fetchedAt: string;
}) {
  // Env missing → nothing can load. Show the single setup empty-state (no
  // tabs); the other reads would all be unconfigured too.
  if (result.status === "unconfigured") {
    return <UnconfiguredState missing={result.missing} fetchedAt={fetchedAt} />;
  }

  const overviewOk = result.status === "ok" ? result : null;
  const data = overviewOk?.data ?? null;

  const dependencies = data?.dependencies ?? null;
  const depEntries = dependencies ? Object.entries(dependencies) : [];
  const anyDepDown = depEntries.some(([, v]) => toneForDependency(v) !== "good");
  const overallTone: StatusTone = !overviewOk
    ? "bad"
    : depEntries.length === 0
      ? "neutral"
      : anyDepDown
        ? "bad"
        : "good";
  const service = data?.service ?? null;
  const analytics = data?.analytics ?? null;

  // The `fraud` event's channel carries the antifraud detector's alert on/off.
  const fraudChannel =
    channels.status === "ok"
      ? (channels.channels.find((c) => c.name === "fraud") ?? null)
      : null;

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
          subtitle="Backend monitor service — health, antifraud scoring, event switches & API surface."
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

        {overviewOk && (
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
        )}
      </PageHero>

      {overviewOk?.parsedLoosely && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
          <p className="text-xs text-muted-foreground">
            The monitor returned data in an unexpected shape, so some fields may
            be displayed loosely. The raw values are still shown below where
            possible.
          </p>
        </div>
      )}

      {/* ── Tabs ────────────────────────────────────────────────── */}
      <Tabs defaultValue="overview">
        <TabsList className="h-auto flex-wrap">
          <TabsTrigger value="overview">
            <Activity className="size-3.5" aria-hidden />
            Overview
          </TabsTrigger>
          <TabsTrigger value="antifraud">
            <ShieldAlert className="size-3.5" aria-hidden />
            Antifraud
          </TabsTrigger>
          <TabsTrigger value="events">
            <Bell className="size-3.5" aria-hidden />
            Events
          </TabsTrigger>
          <TabsTrigger value="channels">
            <Send className="size-3.5" aria-hidden />
            Channels
          </TabsTrigger>
          <TabsTrigger value="endpoints">
            <Route className="size-3.5" aria-hidden />
            Endpoints
          </TabsTrigger>
          <TabsTrigger value="apikeys">
            <KeyRound className="size-3.5" aria-hidden />
            API Keys
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="pt-4">
          {overviewOk ? (
            <OverviewBody data={overviewOk.data} overallTone={overallTone} />
          ) : result.status === "error" ? (
            <InlineNotice
              tone="bad"
              icon={AlertTriangle}
              title="Couldn't load the overview"
            >
              <p className="text-sm text-muted-foreground">{result.message}</p>
              {result.httpStatus != null && (
                <Badge
                  variant="outline"
                  className="gap-1 font-mono text-rose-600 dark:text-rose-400"
                >
                  HTTP {result.httpStatus}
                </Badge>
              )}
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
            </InlineNotice>
          ) : null}
        </TabsContent>

        <TabsContent value="antifraud" className="pt-4">
          <AntifraudTab result={antifraud} fraudChannel={fraudChannel} />
        </TabsContent>

        <TabsContent value="events" className="pt-4">
          <EventsTab result={events} />
        </TabsContent>

        <TabsContent value="channels" className="pt-4">
          <ChannelsTab result={channels} events={events} />
        </TabsContent>

        <TabsContent value="endpoints" className="pt-4">
          <EndpointsTab result={endpoints} />
        </TabsContent>

        <TabsContent value="apikeys" className="pt-4">
          <ApiKeysTab result={apiKeys} />
        </TabsContent>
      </Tabs>

      <LastFetched fetchedAt={fetchedAt} />
    </div>
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

// ─── Inline notice (per-tab error / unconfigured states) ──────────

function InlineNotice({
  tone,
  icon: Icon,
  title,
  children,
}: {
  tone: StatusTone;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children?: React.ReactNode;
}) {
  const border =
    tone === "bad"
      ? "border-rose-500/30 bg-rose-500/5"
      : tone === "warn"
        ? "border-amber-500/30 bg-amber-500/5"
        : "border-border bg-muted/30";
  const ring =
    tone === "bad"
      ? "bg-rose-500/10 ring-rose-500/30 text-rose-500"
      : tone === "warn"
        ? "bg-amber-500/10 ring-amber-500/30 text-amber-500"
        : "bg-muted ring-border text-muted-foreground";
  return (
    <FadeIn>
      <div className={cn("rounded-2xl border p-6", border)}>
        <div className="flex items-start gap-3">
          <div
            className={cn(
              "flex size-10 shrink-0 items-center justify-center rounded-xl ring-1",
              ring,
            )}
          >
            <Icon className="size-5" />
          </div>
          <div className="flex-1 space-y-2">
            <h2 className="text-base font-semibold tracking-tight">{title}</h2>
            {children}
          </div>
        </div>
      </div>
    </FadeIn>
  );
}

/** Convert a non-ok result into a friendly inline notice. */
function ResultNotice({
  status,
  httpStatus,
  message,
  missing,
}: {
  status: "unconfigured" | "error";
  httpStatus?: number | null;
  message?: string;
  missing?: string[];
}) {
  if (status === "unconfigured") {
    return (
      <InlineNotice tone="warn" icon={Settings2} title="Not configured">
        <p className="text-sm text-muted-foreground">
          The monitor connection isn&apos;t set up in this environment
          {missing && missing.length > 0
            ? ` (missing ${missing.join(", ")})`
            : ""}
          .
        </p>
      </InlineNotice>
    );
  }
  return (
    <InlineNotice tone="bad" icon={AlertTriangle} title="Couldn't load">
      <p className="text-sm text-muted-foreground">{message}</p>
      {httpStatus != null && (
        <Badge
          variant="outline"
          className="gap-1 font-mono text-rose-600 dark:text-rose-400"
        >
          HTTP {httpStatus}
        </Badge>
      )}
      <div className="pt-1">
        <MonitorRefreshButton />
      </div>
    </InlineNotice>
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
          subtitle="Backend monitor service — health & analytics freshness."
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

// ─── Overview tab body ────────────────────────────────────────────

function OverviewBody({
  data,
  overallTone,
}: {
  data: MonitorOverview;
  overallTone: StatusTone;
}) {
  const service = data.service ?? null;
  const analytics = data.analytics ?? null;
  const dependencies = data.dependencies ?? null;

  const depEntries = dependencies ? Object.entries(dependencies) : [];
  const freshnessEntries = analytics?.freshness
    ? Object.entries(analytics.freshness)
    : [];

  return (
    <div className="space-y-6">
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

            <StatPanel
              title="Dependencies"
              icon={Plug}
              accent={TONE_ACCENT[overallTone]}
            >
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

            {/* Analytics endpoints (subset — full list is in the Endpoints tab) */}
            <StatPanel title="Analytics endpoints" icon={Route} accent="purple">
              {analytics?.endpoints && analytics.endpoints.length > 0 ? (
                <>
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
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    These are the ClickHouse-served analytics routes the monitor
                    reports. See the <strong>Endpoints</strong> tab for the
                    complete API surface.
                  </p>
                </>
              ) : (
                <p className="py-2 text-sm text-muted-foreground">
                  No analytics endpoints reported.
                </p>
              )}
            </StatPanel>
          </div>
        </div>
      </FadeIn>
    </div>
  );
}

// ─── Antifraud tab ────────────────────────────────────────────────

/** Fraud-risk severity ramp (severity, NOT money House-POV). */
function riskTone(level: string | null | undefined): StatusTone {
  const v = (level ?? "").toLowerCase();
  if (v === "critical" || v === "high") return "bad";
  if (v === "medium") return "warn";
  return "neutral";
}

/** Render a signal's point contribution: flat ("+15") or tiered ("burst +25, critical +40"). */
function renderPoints(points: AntifraudSignal["points"]): string {
  if (points == null) return "—";
  if (typeof points === "number") return `+${points}`;
  const tiers = Object.entries(points);
  if (tiers.length === 0) return "—";
  return tiers.map(([k, v]) => `${k} +${v}`).join(", ");
}

/**
 * On/off switches for the `fraud` event's alert delivery (ntfy + Discord),
 * surfaced on the Antifraud tab. The full topic/server/token/webhook settings
 * live on the Channels tab; this is the quick on/off the detector lacked.
 */
function FraudAlertDelivery({ channel }: { channel: MonitorChannel }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const hasWebhook = Boolean(channel.discord.webhook);
  const anyOn = channel.ntfy.enabled || channel.discord.enabled;

  function patch(
    body: { ntfyEnabled?: boolean; discordEnabled?: boolean },
    successMsg: string,
  ) {
    startTransition(async () => {
      try {
        const res = await updateMonitorChannel({ name: "fraud", ...body });
        if (!res.success) {
          toast.error(res.error);
          return;
        }
        toast.success(successMsg);
        router.refresh();
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to update delivery",
        );
      }
    });
  }

  return (
    <div className="mt-3 space-y-2 rounded-lg border border-border bg-muted/30 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-foreground">Alert delivery</p>
        <StatusBadge tone={anyOn ? "good" : "neutral"}>
          {anyOn ? "On" : "Off"}
        </StatusBadge>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Bell className="size-3.5" aria-hidden />
          ntfy
        </span>
        <Switch
          checked={channel.ntfy.enabled}
          onCheckedChange={(v) =>
            patch({ ntfyEnabled: v }, `Fraud ntfy ${v ? "enabled" : "disabled"}`)
          }
          disabled={isPending}
          aria-label="Toggle fraud ntfy alerts"
        />
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Send className="size-3.5" aria-hidden />
          Discord
        </span>
        <Switch
          checked={channel.discord.enabled}
          onCheckedChange={(v) => {
            if (v && !hasWebhook) {
              toast.error("Add a Discord webhook on the Channels tab first");
              return;
            }
            patch(
              { discordEnabled: v },
              `Fraud Discord ${v ? "enabled" : "disabled"}`,
            );
          }}
          disabled={isPending || (!channel.discord.enabled && !hasWebhook)}
          aria-label="Toggle fraud Discord alerts"
        />
      </div>
      <p className="text-[10px] text-muted-foreground">
        Full ntfy topic / server / token and the Discord webhook are on the{" "}
        <strong>Channels</strong> tab.
      </p>
    </div>
  );
}

function AntifraudTab({
  result,
  fraudChannel,
}: {
  result: AntifraudResult;
  fraudChannel: MonitorChannel | null;
}) {
  if (result.status !== "ok") {
    return (
      <ResultNotice
        status={result.status}
        httpStatus={result.status === "error" ? result.httpStatus : undefined}
        message={result.status === "error" ? result.message : undefined}
        missing={result.status === "unconfigured" ? result.missing : undefined}
      />
    );
  }

  const af = result.data;
  const scoring = af.scoring ?? null;
  const alerting = af.alerting ?? null;
  const riskLevels = scoring?.riskLevels ?? [];
  const signals = scoring?.signals ?? [];
  const guards = af.falsePositiveGuards ?? [];
  const runtime = af.runtime ?? null;
  const runtimeEntries = runtime ? Object.entries(runtime) : [];

  return (
    <div className="space-y-6">
      {result.parsedLoosely && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
          <p className="text-xs text-muted-foreground">
            The antifraud config came back in an unexpected shape; some fields
            may be missing below.
          </p>
        </div>
      )}

      {/* Header: what this system is */}
      <FadeIn>
        <StatPanel
          title={
            <span className="flex flex-wrap items-center gap-2">
              {af.service ?? "Antifraud"}
              <StatusBadge tone={boolTone(af.enabled)}>
                {af.enabled === false ? "Disabled" : "Active"}
              </StatusBadge>
            </span>
          }
          icon={ShieldAlert}
          accent="rose"
        >
          {af.mode && (
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {af.mode}
            </p>
          )}
          {af.description && (
            <p className="text-sm text-muted-foreground">{af.description}</p>
          )}
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-2.5">
            <Info className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <p className="text-[11px] text-muted-foreground">
              This system is read-only / advisory (notify-only) and has no
              enforcement. The detector process itself is an env kill-switch
              (<code>FRAUD_ENABLED</code>), but you can turn its alert delivery
              on or off below.
            </p>
          </div>
          {fraudChannel && <FraudAlertDelivery channel={fraudChannel} />}
        </StatPanel>
      </FadeIn>

      {/* Scoring KPIs */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiTile
          label="Max score"
          value={scoring?.maxScore != null ? String(scoring.maxScore) : "—"}
          icon={Gauge}
          accent="purple"
        />
        <KpiTile
          label="Alert at ≥"
          value={
            alerting?.minScoreToAlert != null
              ? String(alerting.minScoreToAlert)
              : "—"
          }
          icon={ShieldAlert}
          accent="rose"
        />
        <KpiTile
          label="Scan interval"
          value={formatMs(numField(runtime, "scanIntervalMs"))}
          icon={Timer}
          accent="blue"
        />
        <KpiTile
          label="Window"
          value={
            numField(runtime, "windowMinutes") != null
              ? `${numField(runtime, "windowMinutes")} min`
              : "—"
          }
          icon={Hourglass}
          accent="cyan"
        />
      </div>

      {/* Risk levels */}
      {riskLevels.length > 0 && (
        <FadeIn>
          <div className="space-y-3">
            <SectionHeading icon={Layers} title="Risk levels" />
            <div className="flex flex-wrap gap-2">
              {riskLevels.map((lvl, i) => (
                <Badge
                  key={lvl.level ?? i}
                  variant="outline"
                  className={cn("gap-1.5", TONE_BADGE[riskTone(lvl.level)])}
                >
                  <span className="font-semibold">{lvl.level ?? "—"}</span>
                  <span className="opacity-80">≥ {lvl.minScore ?? 0}</span>
                </Badge>
              ))}
            </div>
          </div>
        </FadeIn>
      )}

      {/* Signals table */}
      <FadeIn>
        <div className="space-y-3">
          <SectionHeading
            icon={Shield}
            title="Scoring signals"
            action={
              scoring?.note ? (
                <span className="text-[11px] text-muted-foreground">
                  {scoring.note}
                </span>
              ) : undefined
            }
          />
          {signals.length === 0 ? (
            <p className="text-sm text-muted-foreground">No signals reported.</p>
          ) : (
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Category</TableHead>
                    <TableHead>Signal</TableHead>
                    <TableHead className="text-right">Points</TableHead>
                    <TableHead>Description</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {signals.map((sig, i) => (
                    <TableRow key={sig.key ?? i}>
                      <TableCell className="whitespace-nowrap font-medium">
                        {sig.category ?? "—"}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <code className="text-xs">{sig.key ?? "—"}</code>
                          {sig.tiered && (
                            <Badge
                              variant="outline"
                              className="gap-1 text-[10px] text-amber-600 dark:text-amber-400"
                            >
                              tiered
                            </Badge>
                          )}
                          {sig.conditional && (
                            <Badge
                              variant="outline"
                              className="gap-1 text-[10px] text-cyan-600 dark:text-cyan-400"
                            >
                              conditional
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-mono whitespace-nowrap tabular-nums">
                        {renderPoints(sig.points)}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {sig.description ?? "—"}
                        {sig.conditional && (
                          <span className="mt-0.5 block text-[11px] italic">
                            {sig.conditional}
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      </FadeIn>

      {/* Alerting + guards */}
      <div className="grid gap-4 lg:grid-cols-2">
        {alerting && (
          <StatPanel title="Alerting" icon={Bell} accent="amber">
            <div className="space-y-3">
              <PanelRow
                label="Min score to alert"
                value={alerting.minScoreToAlert ?? "—"}
              />
              {alerting.gating && (
                <p className="text-xs text-muted-foreground">{alerting.gating}</p>
              )}
              {alerting.strongSignals && alerting.strongSignals.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-foreground">
                    Strong signals
                  </p>
                  <ul className="space-y-1">
                    {alerting.strongSignals.map((s, i) => (
                      <li
                        key={i}
                        className="flex items-start gap-2 text-xs text-muted-foreground"
                      >
                        <Zap className="mt-0.5 size-3 shrink-0 text-amber-500" />
                        {s}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </StatPanel>
        )}

        {guards.length > 0 && (
          <StatPanel title="False-positive guards" icon={Shield} accent="emerald">
            <ul className="space-y-1.5">
              {guards.map((g, i) => (
                <li
                  key={i}
                  className="flex items-start gap-2 text-xs text-muted-foreground"
                >
                  <CheckCircle2 className="mt-0.5 size-3 shrink-0 text-emerald-500" />
                  {g}
                </li>
              ))}
            </ul>
          </StatPanel>
        )}
      </div>

      {/* Runtime config */}
      {runtimeEntries.length > 0 && (
        <FadeIn>
          <div className="space-y-3">
            <SectionHeading icon={Settings2} title="Runtime" />
            <div className="grid gap-x-6 gap-y-1 rounded-lg border p-4 sm:grid-cols-2">
              {runtimeEntries.map(([k, v]) => (
                <PanelRow
                  key={k}
                  label={k}
                  value={
                    typeof v === "boolean" ? (
                      <BoolBadge value={v} />
                    ) : (
                      <span className="font-mono text-xs">
                        {/dedupettlms|scanintervalms/i.test(k)
                          ? formatMs(Number(v))
                          : String(v)}
                      </span>
                    )
                  }
                />
              ))}
            </div>
          </div>
        </FadeIn>
      )}
    </div>
  );
}

// ─── Events tab (toggle on/off) ───────────────────────────────────

function EventsTab({ result }: { result: MonitorEventsResult }) {
  if (result.status !== "ok") {
    return (
      <ResultNotice
        status={result.status}
        httpStatus={result.status === "error" ? result.httpStatus : undefined}
        message={result.status === "error" ? result.message : undefined}
        missing={result.status === "unconfigured" ? result.missing : undefined}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-xl border border-border bg-muted/30 p-3">
        <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p className="text-xs text-muted-foreground">
          Toggle a notification source on or off. When off, the monitor stops
          pushing that event&apos;s alerts. Changes apply immediately and are
          recorded in the admin audit log.
        </p>
      </div>

      <SectionHeading icon={Bell} title="Notification events" />
      <div className="grid gap-3 sm:grid-cols-2">
        {result.events.map((event) => (
          <EventToggleRow key={event.name} event={event} />
        ))}
      </div>
    </div>
  );
}

function EventToggleRow({ event }: { event: MonitorEvent }) {
  const [enabled, setEnabled] = useState(event.enabled);
  const [isPending, startTransition] = useTransition();

  function onToggle(next: boolean) {
    const previous = enabled;
    setEnabled(next); // optimistic
    startTransition(async () => {
      try {
        const res = await toggleMonitorEvent({ name: event.name, enabled: next });
        if (!res.success) {
          setEnabled(previous);
          toast.error(res.error);
          return;
        }
        setEnabled(res.enabled);
        toast.success(
          `${event.name} ${res.enabled ? "enabled" : "disabled"}`,
        );
      } catch (err) {
        setEnabled(previous);
        toast.error(
          err instanceof Error ? err.message : "Failed to toggle event",
        );
      }
    });
  }

  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 rounded-xl border bg-card p-4 ring-1 ring-foreground/5 transition-colors",
        enabled ? "border-emerald-500/30" : "border-border",
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        <div
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-lg ring-1",
            enabled
              ? "bg-emerald-500/10 text-emerald-500 ring-emerald-500/30"
              : "bg-muted text-muted-foreground ring-border",
          )}
        >
          <Bell className="size-4" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium capitalize">
            {event.name}
          </p>
          <p className="text-xs text-muted-foreground">
            {enabled ? "Notifications on" : "Notifications off"}
          </p>
        </div>
      </div>
      <Switch
        checked={enabled}
        onCheckedChange={onToggle}
        disabled={isPending}
        aria-label={`Toggle ${event.name} notifications`}
      />
    </div>
  );
}

// ─── Channels tab (per-event notification fan-out: ntfy AND/OR Discord) ──

const NTFY_BADGE =
  "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30";
const DISCORD_BADGE =
  "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 border-indigo-500/30";

// Mirror of the backend validation (see notification-channels handoff doc) so
// the form can give instant feedback before the round-trip.
const NTFY_TOPIC_RE = /^[A-Za-z0-9_-]{1,64}$/;
const HTTP_URL_RE = /^https?:\/\/.+/i;
const DISCORD_WEBHOOK_RE =
  /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/i;

/** "topic · ntfy.sh" summary for the ntfy sub-section. */
function ntfySummary(ch: MonitorChannel): string {
  const server = (ch.ntfy.server ?? "https://ntfy.sh").replace(
    /^https?:\/\//,
    "",
  );
  return `${ch.ntfy.topic ?? "—"} · ${server}`;
}

function ChannelsTab({
  result,
  events,
}: {
  result: MonitorChannelsResult;
  events: MonitorEventsResult;
}) {
  const router = useRouter();
  const [rows, setRows] = useState<MonitorChannel[]>(
    result.status === "ok" ? result.channels : [],
  );
  const [editing, setEditing] = useState<MonitorChannel | null>(null);

  // Read-only "source disabled" hint from the Events read — the master on/off
  // for the 6 sources lives on the Events tab (the `fraud` event is not in that
  // list, so its on/off is purely the per-channel switches below).
  const enabledByName = useMemo(() => {
    const m = new Map<string, boolean>();
    if (events.status === "ok") {
      for (const e of events.events) m.set(e.name, e.enabled);
    }
    return m;
  }, [events]);

  if (result.status !== "ok") {
    return (
      <ResultNotice
        status={result.status}
        httpStatus={result.status === "error" ? result.httpStatus : undefined}
        message={result.status === "error" ? result.message : undefined}
        missing={result.status === "unconfigured" ? result.missing : undefined}
      />
    );
  }

  function onSaved(ch: MonitorChannel) {
    setRows((prev) => prev.map((r) => (r.name === ch.name ? ch : r)));
    setEditing(null);
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-xl border border-border bg-muted/30 p-3">
        <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p className="text-xs text-muted-foreground">
          Each event can fan out to{" "}
          <strong className="text-foreground">ntfy</strong> and/or{" "}
          <strong className="text-foreground">Discord</strong> — toggle each
          destination independently. This is also where{" "}
          <strong className="text-foreground">fraud</strong> (the antifraud
          detector&apos;s alerts) is turned on or off. Use{" "}
          <strong className="text-foreground">Edit</strong> to set the ntfy
          topic/server/token or a Discord webhook. Secrets are masked — leaving a
          secret field blank keeps the stored value.
        </p>
      </div>

      <SectionHeading icon={Send} title="Notification channels" />
      <div className="grid gap-3 sm:grid-cols-2">
        {rows.map((ch) => (
          <ChannelRow
            key={ch.name}
            channel={ch}
            sourceEnabled={enabledByName.get(ch.name)}
            onSaved={onSaved}
            onEdit={() => setEditing(ch)}
          />
        ))}
      </div>

      <ChannelEditDialog
        channel={editing}
        onClose={() => setEditing(null)}
        onSaved={onSaved}
      />
    </div>
  );
}

function ChannelRow({
  channel,
  sourceEnabled,
  onSaved,
  onEdit,
}: {
  channel: MonitorChannel;
  sourceEnabled: boolean | undefined;
  onSaved: (ch: MonitorChannel) => void;
  onEdit: () => void;
}) {
  const [isPending, startTransition] = useTransition();
  const hasWebhook = Boolean(channel.discord.webhook);

  function patch(
    body: { ntfyEnabled?: boolean; discordEnabled?: boolean },
    successMsg: string,
  ) {
    startTransition(async () => {
      try {
        const res = await updateMonitorChannel({ name: channel.name, ...body });
        if (!res.success) {
          toast.error(res.error);
          return;
        }
        toast.success(successMsg);
        onSaved(res.channel);
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to update channel",
        );
      }
    });
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 ring-1 ring-foreground/5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium capitalize">
            {channel.name}
          </p>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
            {!channel.configured && (
              <span className="text-[10px] text-muted-foreground">default</span>
            )}
            {sourceEnabled === false && (
              <StatusBadge tone="neutral">source off</StatusBadge>
            )}
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onEdit}
          disabled={isPending}
        >
          <Pencil className="size-3.5" aria-hidden />
          Edit
        </Button>
      </div>

      {/* ntfy sub-section */}
      <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/30 px-2.5 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Badge
            variant="outline"
            className={cn("shrink-0 gap-1 text-[10px]", NTFY_BADGE)}
          >
            <Bell className="size-3" aria-hidden />
            ntfy
          </Badge>
          <div className="min-w-0">
            <code className="block truncate text-xs text-muted-foreground">
              {ntfySummary(channel)}
            </code>
            <span className="text-[10px] text-muted-foreground">
              Token {channel.ntfy.tokenSet ? "set" : "unset"}
            </span>
          </div>
        </div>
        <Switch
          checked={channel.ntfy.enabled}
          onCheckedChange={(v) =>
            patch(
              { ntfyEnabled: v },
              `${channel.name} ntfy ${v ? "enabled" : "disabled"}`,
            )
          }
          disabled={isPending}
          aria-label={`Toggle ${channel.name} ntfy notifications`}
        />
      </div>

      {/* Discord sub-section */}
      <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/30 px-2.5 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Badge
            variant="outline"
            className={cn("shrink-0 gap-1 text-[10px]", DISCORD_BADGE)}
          >
            <Send className="size-3" aria-hidden />
            Discord
          </Badge>
          <code className="block truncate text-xs text-muted-foreground">
            {channel.discord.webhook ?? "no webhook set"}
          </code>
        </div>
        <Switch
          checked={channel.discord.enabled}
          onCheckedChange={(v) => {
            if (v && !hasWebhook) {
              toast.error("Add a Discord webhook in Edit first");
              return;
            }
            patch(
              { discordEnabled: v },
              `${channel.name} Discord ${v ? "enabled" : "disabled"}`,
            );
          }}
          disabled={isPending || (!channel.discord.enabled && !hasWebhook)}
          aria-label={`Toggle ${channel.name} Discord notifications`}
        />
      </div>
    </div>
  );
}

function ChannelEditDialog({
  channel,
  onClose,
  onSaved,
}: {
  channel: MonitorChannel | null;
  onClose: () => void;
  onSaved: (ch: MonitorChannel) => void;
}) {
  return (
    <Dialog
      open={channel != null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        {channel && (
          // Key by name so the form state resets each time a row is opened.
          <ChannelEditForm
            key={channel.name}
            channel={channel}
            onClose={onClose}
            onSaved={onSaved}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ChannelEditForm({
  channel,
  onClose,
  onSaved,
}: {
  channel: MonitorChannel;
  onClose: () => void;
  onSaved: (ch: MonitorChannel) => void;
}) {
  const [ntfyEnabled, setNtfyEnabled] = useState(channel.ntfy.enabled);
  const [ntfyTopic, setNtfyTopic] = useState(channel.ntfy.topic ?? "");
  const [ntfyServer, setNtfyServer] = useState(channel.ntfy.server ?? "");
  const [ntfyToken, setNtfyToken] = useState("");
  const [discordEnabled, setDiscordEnabled] = useState(channel.discord.enabled);
  const [discordWebhookUrl, setDiscordWebhookUrl] = useState("");
  const [isPending, startTransition] = useTransition();

  const hasWebhook = Boolean(channel.discord.webhook);

  function validate(): string | null {
    const topic = ntfyTopic.trim();
    if (topic && !NTFY_TOPIC_RE.test(topic)) {
      return "Topic must be 1–64 letters, numbers, _ or -";
    }
    const server = ntfyServer.trim();
    if (server && !HTTP_URL_RE.test(server)) {
      return "Server must be an http(s):// URL";
    }
    const webhook = discordWebhookUrl.trim();
    if (webhook && !DISCORD_WEBHOOK_RE.test(webhook)) {
      return "Enter a valid Discord webhook URL";
    }
    if (discordEnabled && !hasWebhook && !webhook) {
      return "A Discord webhook URL is required to enable Discord";
    }
    return null;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const err = validate();
    if (err) {
      toast.error(err);
      return;
    }
    startTransition(async () => {
      try {
        const res = await updateMonitorChannel({
          name: channel.name,
          ntfyEnabled,
          // Topic/server are non-secret and pre-filled; send them as-is. Blank
          // is pruned server-side (keeps the stored value).
          ntfyTopic: ntfyTopic.trim() || undefined,
          ntfyServer: ntfyServer.trim() || undefined,
          // Secrets can't be pre-filled (masked) → only send when re-entered;
          // blank means "keep the stored value".
          ntfyToken: ntfyToken.trim() || undefined,
          discordEnabled,
          discordWebhookUrl: discordWebhookUrl.trim() || undefined,
        });
        if (!res.success) {
          toast.error(res.error);
          return;
        }
        toast.success(`${channel.name} channels updated`);
        onSaved(res.channel);
      } catch (err2) {
        toast.error(
          err2 instanceof Error ? err2.message : "Failed to save channel",
        );
      }
    });
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="capitalize">{channel.name} channels</DialogTitle>
        <DialogDescription>
          Send this event to ntfy and/or Discord. Secrets are masked — leave a
          secret field blank to keep the stored value.
        </DialogDescription>
      </DialogHeader>
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* ntfy */}
        <div className="space-y-3 rounded-lg border p-3">
          <div className="flex items-center justify-between gap-3">
            <Label className="flex items-center gap-1.5">
              <Bell className="size-4" aria-hidden />
              ntfy
            </Label>
            <Switch
              checked={ntfyEnabled}
              onCheckedChange={setNtfyEnabled}
              disabled={isPending}
              aria-label="Enable ntfy"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="channel-ntfy-topic">Topic</Label>
            <Input
              id="channel-ntfy-topic"
              value={ntfyTopic}
              onChange={(e) => setNtfyTopic(e.target.value)}
              placeholder="server default"
              maxLength={64}
              disabled={isPending}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="channel-ntfy-server">Server</Label>
            <Input
              id="channel-ntfy-server"
              value={ntfyServer}
              onChange={(e) => setNtfyServer(e.target.value)}
              placeholder="https://ntfy.sh"
              disabled={isPending}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="channel-ntfy-token">
              Token{" "}
              <span className="text-xs font-normal text-muted-foreground">
                ({channel.ntfy.tokenSet ? "set" : "unset"} — blank keeps it)
              </span>
            </Label>
            <Input
              id="channel-ntfy-token"
              type="password"
              value={ntfyToken}
              onChange={(e) => setNtfyToken(e.target.value)}
              placeholder="leave blank to keep current"
              autoComplete="off"
              disabled={isPending}
            />
          </div>
        </div>

        {/* Discord */}
        <div className="space-y-3 rounded-lg border p-3">
          <div className="flex items-center justify-between gap-3">
            <Label className="flex items-center gap-1.5">
              <Send className="size-4" aria-hidden />
              Discord
            </Label>
            <Switch
              checked={discordEnabled}
              onCheckedChange={setDiscordEnabled}
              disabled={isPending}
              aria-label="Enable Discord"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="channel-discord-url">
              Webhook URL{" "}
              <span className="text-xs font-normal text-muted-foreground">
                ({hasWebhook ? "set" : "unset"} — blank keeps it)
              </span>
            </Label>
            <Input
              id="channel-discord-url"
              value={discordWebhookUrl}
              onChange={(e) => setDiscordWebhookUrl(e.target.value)}
              placeholder="https://discord.com/api/webhooks/123/abc"
              autoComplete="off"
              disabled={isPending}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={isPending}
            className="w-full sm:w-auto"
          >
            Cancel
          </Button>
          <Button type="submit" disabled={isPending} className="w-full sm:w-auto">
            {isPending ? "Saving…" : "Save channel"}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

// ─── Endpoints tab (full API surface) ─────────────────────────────

const METHOD_BADGE: Record<string, string> = {
  GET: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  PUT: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
  PATCH: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
  POST: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  DELETE: "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30",
};

function EndpointsTab({ result }: { result: MonitorEndpointsResult }) {
  if (result.status !== "ok") {
    return (
      <ResultNotice
        status={result.status}
        httpStatus={result.status === "error" ? result.httpStatus : undefined}
        message={result.status === "error" ? result.message : undefined}
        missing={result.status === "unconfigured" ? result.missing : undefined}
      />
    );
  }

  // Group by first tag (fallback to first path segment, then "other").
  const groups = new Map<string, MonitorApiEndpoint[]>();
  for (const ep of result.endpoints) {
    const key =
      ep.tags[0] ?? ep.path.split("/").filter(Boolean)[0] ?? "other";
    const arr = groups.get(key) ?? [];
    arr.push(ep);
    groups.set(key, arr);
  }
  const groupNames = [...groups.keys()].sort();

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-xl border border-border bg-muted/30 p-3">
        <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p className="text-xs text-muted-foreground">
          The complete API surface from the monitor&apos;s OpenAPI document
          ({result.endpoints.length} routes). The Overview tab&apos;s
          &quot;Analytics endpoints&quot; only lists the ClickHouse-served
          subset.
        </p>
      </div>

      {groupNames.map((name) => {
        const eps = groups.get(name)!;
        return (
          <FadeIn key={name}>
            <div className="space-y-2">
              <SectionHeading
                icon={Route}
                title={<span className="capitalize">{name}</span>}
              />
              <ul className="space-y-1.5">
                {eps.map((ep) => (
                  <li
                    key={`${ep.method} ${ep.path}`}
                    className="flex items-center gap-2 rounded-md border bg-muted/30 px-2.5 py-2"
                  >
                    <Badge
                      variant="outline"
                      className={cn(
                        "w-[58px] shrink-0 justify-center font-mono text-[10px]",
                        METHOD_BADGE[ep.method] ?? TONE_BADGE.neutral,
                      )}
                    >
                      {ep.method}
                    </Badge>
                    <code className="shrink-0 text-xs">{ep.path}</code>
                    {ep.summary && (
                      <span className="truncate text-xs text-muted-foreground">
                        — {ep.summary}
                      </span>
                    )}
                    <span className="ml-auto shrink-0">
                      {ep.authRequired ? (
                        <Lock
                          className="size-3.5 text-amber-500"
                          aria-label="Requires auth"
                        />
                      ) : (
                        <Unlock
                          className="size-3.5 text-muted-foreground"
                          aria-label="Public"
                        />
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </FadeIn>
        );
      })}
    </div>
  );
}

// ─── API Keys tab ─────────────────────────────────────────────────

function ApiKeysTab({ result }: { result: MonitorApiKeysResult }) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [created, setCreated] = useState<CreatedMonitorApiKey | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<MonitorApiKey | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = label.trim();
    if (!trimmed) {
      toast.error("Label is required");
      return;
    }
    startTransition(async () => {
      const res = await createApiKey({ label: trimmed });
      if (!res.success) {
        toast.error(res.error);
        return;
      }
      setCreated(res.created);
      setLabel("");
      setCreateOpen(false);
      toast.success("API key created");
      router.refresh();
    });
  }

  function handleRevoke() {
    if (!revokeTarget) return;
    const target = revokeTarget;
    startTransition(async () => {
      const res = await revokeApiKey({ id: target.id });
      if (!res.success) {
        toast.error(res.error);
        return;
      }
      toast.success(`Revoked ${target.label}`);
      setRevokeTarget(null);
      router.refresh();
    });
  }

  if (result.status !== "ok") {
    return (
      <ResultNotice
        status={result.status}
        httpStatus={result.status === "error" ? result.httpStatus : undefined}
        message={result.status === "error" ? result.message : undefined}
        missing={result.status === "unconfigured" ? result.missing : undefined}
      />
    );
  }

  const keys = result.keys;
  const activeCount = keys.filter((k) => k.active).length;

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-xl border border-border bg-muted/30 p-3">
        <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p className="text-xs text-muted-foreground">
          Bearer keys for the monitor API, minted server-side with the master
          token. A new key&apos;s secret is shown{" "}
          <strong className="text-foreground">once</strong> at creation and can
          never be retrieved again — copy it immediately. Revoking takes effect
          within ~30s.
        </p>
      </div>

      <SectionHeading
        icon={KeyRound}
        title={
          <span className="flex items-baseline gap-2">
            API keys
            <span className="text-xs font-normal text-muted-foreground">
              {activeCount} active · {keys.length} total
            </span>
          </span>
        }
        action={
          <Button size="sm" onClick={() => setCreateOpen(true)} disabled={isPending}>
            <Plus className="size-4" aria-hidden />
            Create key
          </Button>
        }
      />

      {keys.length === 0 ? (
        <p className="rounded-lg border bg-muted/20 p-6 text-center text-sm text-muted-foreground">
          No API keys yet. Create one to grant programmatic access to the
          monitor.
        </p>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Label</TableHead>
                <TableHead>Key prefix</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.map((k) => (
                <TableRow key={k.id}>
                  <TableCell className="font-medium">{k.label}</TableCell>
                  <TableCell>
                    {k.key_prefix ? (
                      <code className="text-xs">{k.key_prefix}…</code>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {k.created_at ? (
                      <span className="tabular-nums" title={k.created_at}>
                        {formatDateTime(asUtc(k.created_at))}
                      </span>
                    ) : (
                      "—"
                    )}
                    {k.created_by && (
                      <span className="block text-[11px]">by {k.created_by}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {k.active ? (
                      <StatusBadge tone="good">Active</StatusBadge>
                    ) : (
                      <StatusBadge tone="neutral">Revoked</StatusBadge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {k.active ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={isPending}
                        onClick={() => setRevokeTarget(k)}
                        className="border-rose-500/40 text-rose-600 hover:bg-rose-500/10 hover:text-rose-700 dark:text-rose-400"
                      >
                        <Trash2 className="size-3.5" aria-hidden />
                        Revoke
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {k.revoked_at
                          ? `revoked ${formatRelative(asUtc(k.revoked_at))}`
                          : "revoked"}
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create API key</DialogTitle>
            <DialogDescription>
              Give the key a recognizable label. The secret is shown once after
              creation.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="monitor-key-label">Label</Label>
              <Input
                id="monitor-key-label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. dashboard-prod"
                maxLength={100}
                autoFocus
                required
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setCreateOpen(false)}
                disabled={isPending}
                className="w-full sm:w-auto"
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isPending} className="w-full sm:w-auto">
                {isPending ? "Creating…" : "Create key"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* One-time secret reveal */}
      <Dialog
        open={created != null}
        onOpenChange={(open) => {
          if (!open) setCreated(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldCheck className="size-4 text-emerald-500" aria-hidden />
              Key created — copy it now
            </DialogTitle>
            <DialogDescription>
              This is the only time the full key for{" "}
              <span className="font-medium text-foreground">{created?.label}</span>{" "}
              is shown. Store it securely — it can&apos;t be retrieved again.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex items-center gap-2 rounded-lg border bg-muted/40 p-3">
              <code className="flex-1 break-all text-xs">{created?.key}</code>
              {created?.key && <CopyButton value={created.key} label="API key" />}
            </div>
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5">
              <AlertTriangle
                className="mt-0.5 size-3.5 shrink-0 text-amber-500"
                aria-hidden
              />
              <p className="text-[11px] text-muted-foreground">
                Keep this server-side only — never embed it in browser code. If
                it leaks, revoke it here and create a new one.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setCreated(null)} className="w-full sm:w-auto">
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revoke confirm */}
      <Dialog
        open={revokeTarget != null}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke API key</DialogTitle>
            <DialogDescription>
              Revoke{" "}
              <span className="font-medium text-foreground">
                {revokeTarget?.label}
              </span>
              {revokeTarget?.key_prefix ? ` (${revokeTarget.key_prefix}…)` : ""}? Any
              service using it stops working within ~30s. This can&apos;t be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setRevokeTarget(null)}
              disabled={isPending}
              className="w-full sm:w-auto"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleRevoke}
              disabled={isPending}
              className="w-full bg-rose-600 text-white hover:bg-rose-700 sm:w-auto"
            >
              {isPending ? "Revoking…" : "Revoke key"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Row sub-components ───────────────────────────────────────────

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

/** Read a numeric field out of the open runtime record (string/number/bool). */
function numField(
  runtime: Record<string, number | string | boolean> | null | undefined,
  key: string,
): number | null {
  if (!runtime) return null;
  const v = runtime[key];
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** Normalize a bare Postgres timestamp string to a UTC Date (for formatters). */
function asUtc(raw: string): Date {
  return parseUtcTimestamp(raw) ?? new Date(raw);
}
