import {
  Activity,
  Users,
  LogIn,
  ScrollText,
  Clock,
  Gauge,
  Database,
  Zap,
  Server,
  Timer,
  Layers,
} from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import {
  getSessionHealth,
  getLoginsToday,
  getAuditEventsToday,
  getAuditEventCountPerDay,
  getTopAdminsByActions,
  getEventTypeBreakdown,
  getTableRowCounts,
} from "@/lib/queries/admin-stats";
import { adminDb } from "@/lib/admin-db";
import { getQueryTimingStats } from "@/lib/observability/query-timings";
import { formatNumber, formatRelative } from "@/lib/utils/format";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
  KpiTile,
  StatPanel,
  PanelRow,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AuditChart } from "./audit-chart";
import { RefreshButton } from "./refresh-button";

export const metadata = { title: "Dashboard Stats" };
// Always render on demand so row counts / audit numbers reflect the most
// recent state — this is an ops page, not a cacheable view.
export const dynamic = "force-dynamic";

export default async function SystemStatsPage() {
  await requirePageAccess("/system/stats");

  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  );
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [
    sessionHealth,
    loginsToday,
    auditEventsToday,
    auditSeries,
    topAdmins,
    eventTypeBreakdown,
    tableCounts,
    totalAdminUsers,
  ] = await Promise.all([
    getSessionHealth(),
    getLoginsToday(),
    getAuditEventsToday(),
    getAuditEventCountPerDay(7),
    getTopAdminsByActions(10, startOfMonth),
    getEventTypeBreakdown(startOfMonth),
    getTableRowCounts(),
    adminDb.admin_users.count(),
  ]);

  // Query timings are sampled in-memory per function instance. Reading is
  // synchronous — no await needed. See src/lib/observability/query-timings.ts
  // for the (critical) caveats about serverless lifetime.
  const timingStats = getQueryTimingStats({ slowestLimit: 10 });

  const nodeVersion = process.version;
  const nextVersion =
    (process.env.NEXT_RUNTIME ? "edge" : null) ??
    // next-env.d.ts doesn't expose the version, but we can read it from
    // the installed package at runtime. Kept lazy so the unreachable path
    // (running outside a Next project) doesn't crash the render.
    readNextVersion();
  const commitSha =
    process.env.VERCEL_GIT_COMMIT_SHA ??
    process.env.GIT_COMMIT_SHA ??
    process.env.SOURCE_COMMIT ??
    null;
  const deploymentId =
    process.env.VERCEL_DEPLOYMENT_ID ?? process.env.DEPLOYMENT_ID ?? null;
  const vercelEnv = process.env.VERCEL_ENV ?? null;
  const vercelRegion = process.env.VERCEL_REGION ?? null;

  // Cap the event-type breakdown at a sensible number of rows — the full
  // list can be long, and most tails are noise. The remainder rolls up
  // under "Other" so the percentages still add to 100%.
  const breakdownMax = 8;
  const breakdownTotal = eventTypeBreakdown.reduce(
    (sum, row) => sum + row.count,
    0,
  );
  const breakdownTop = eventTypeBreakdown.slice(0, breakdownMax);
  const breakdownRest = eventTypeBreakdown.slice(breakdownMax);
  const breakdownOther = breakdownRest.reduce((sum, row) => sum + row.count, 0);

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Gauge}
          title="Admin Dashboard Stats"
          subtitle="Operational health of the admin panel itself — sessions, audit throughput, query latency, and cron freshness."
          action={<RefreshButton />}
        />
      </PageHero>

      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiTile
          label="Active Sessions"
          value={formatNumber(sessionHealth.activeSessions)}
          sub={`${sessionHealth.distinctActiveAdmins} distinct admin${sessionHealth.distinctActiveAdmins === 1 ? "" : "s"}`}
          icon={Users}
          accent="blue"
        />
        <KpiTile
          label="Logins Today"
          value={formatNumber(loginsToday)}
          sub={`${startOfToday.toLocaleDateString(undefined, { month: "short", day: "numeric" })} onwards`}
          icon={LogIn}
          accent="emerald"
        />
        <KpiTile
          label="Audit Events Today"
          value={formatNumber(auditEventsToday)}
          sub={`${formatNumber(breakdownTotal)} this month`}
          icon={ScrollText}
          accent="amber"
        />
        <KpiTile
          label="Users"
          value={formatNumber(totalAdminUsers)}
          sub="Total accounts"
          icon={Users}
          accent="purple"
        />
      </div>

      {/* Query performance */}
      <div className="space-y-3">
        <SectionHeading icon={Timer} title="Query performance" />
        <p className="text-xs text-muted-foreground">
          Sampled in the current function instance from a {formatNumber(timingStats.ringSize)}
          -entry ring buffer. Numbers reset when a cold start happens, and are
          not shared across Vercel regions or replicas.
        </p>
        <FadeIn className="grid gap-4 lg:grid-cols-3">
          <StatPanel title="Latency" icon={Zap} accent="cyan">
            <div className="text-3xl font-bold tabular-nums font-mono">
              {timingStats.percentiles.p50.toFixed(1)}
              <span className="text-sm font-normal text-muted-foreground">
                {" "}
                ms
              </span>
            </div>
            <div className="mt-3 space-y-1">
              <PanelRow
                label="p50 (median)"
                value={`${timingStats.percentiles.p50.toFixed(1)} ms`}
              />
              <PanelRow
                label="p95"
                value={`${timingStats.percentiles.p95.toFixed(1)} ms`}
              />
              <PanelRow
                label="p99"
                value={`${timingStats.percentiles.p99.toFixed(1)} ms`}
              />
              <PanelRow
                label="Samples"
                value={formatNumber(timingStats.sampleCount)}
              />
            </div>
          </StatPanel>

          <StatPanel title="Slowest queries (recent)" icon={Timer} accent="rose">
            {timingStats.slowest.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No samples yet — navigate a few pages, then refresh.
              </p>
            ) : (
              <div className="max-h-[260px] overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs">Query</TableHead>
                      <TableHead className="text-right text-xs">Duration</TableHead>
                      <TableHead className="text-right text-xs">When</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {timingStats.slowest.map((s, i) => (
                      <TableRow key={`${s.query}-${s.at}-${i}`}>
                        <TableCell className="font-mono text-xs">
                          {s.query}
                        </TableCell>
                        <TableCell className="text-right font-mono tabular-nums text-xs">
                          {s.durationMs.toFixed(1)} ms
                        </TableCell>
                        <TableCell className="text-right text-xs text-muted-foreground">
                          {formatRelative(s.at)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </StatPanel>

          <StatPanel title="Per-query aggregates" icon={Layers} accent="purple">
            {timingStats.perQuery.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No samples yet.
              </p>
            ) : (
              <div className="max-h-[260px] overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs">Query</TableHead>
                      <TableHead className="text-right text-xs">N</TableHead>
                      <TableHead className="text-right text-xs">Mean</TableHead>
                      <TableHead className="text-right text-xs">p95</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {timingStats.perQuery.map((q) => (
                      <TableRow key={q.query}>
                        <TableCell className="font-mono text-xs">
                          {q.query}
                        </TableCell>
                        <TableCell className="text-right font-mono tabular-nums text-xs">
                          {formatNumber(q.count)}
                        </TableCell>
                        <TableCell className="text-right font-mono tabular-nums text-xs">
                          {q.meanMs.toFixed(1)}
                        </TableCell>
                        <TableCell className="text-right font-mono tabular-nums text-xs">
                          {q.p95Ms.toFixed(1)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </StatPanel>
        </FadeIn>
      </div>

      {/* Admin activity */}
      <div className="space-y-3">
        <SectionHeading icon={Activity} title="Admin activity" />
        <FadeIn className="grid gap-4 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <AuditChart data={auditSeries} />
          </div>
          <StatPanel
            title="Event type breakdown (this month)"
            icon={ScrollText}
            accent="amber"
          >
            {breakdownTotal === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No events this month.
              </p>
            ) : (
              <div className="space-y-2">
                {breakdownTop.map((row) => {
                  const pct = (row.count / breakdownTotal) * 100;
                  return (
                    <div key={row.eventType} className="space-y-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-mono truncate" title={row.eventType}>
                          {row.eventType}
                        </span>
                        <span className="font-mono tabular-nums text-muted-foreground">
                          {formatNumber(row.count)} · {pct.toFixed(1)}%
                        </span>
                      </div>
                      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                        <div
                          className="h-full bg-primary/60"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
                {breakdownOther > 0 && (
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">
                        Other ({breakdownRest.length} types)
                      </span>
                      <span className="font-mono tabular-nums text-muted-foreground">
                        {formatNumber(breakdownOther)} ·{" "}
                        {((breakdownOther / breakdownTotal) * 100).toFixed(1)}%
                      </span>
                    </div>
                    <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full bg-muted-foreground/40"
                        style={{
                          width: `${(breakdownOther / breakdownTotal) * 100}%`,
                        }}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}
          </StatPanel>
        </FadeIn>

        <FadeIn>
          <StatPanel
            title={`Top admins by actions (since ${startOfMonth.toLocaleDateString(undefined, { month: "short", day: "numeric" })})`}
            icon={Users}
            accent="blue"
          >
            {topAdmins.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No admin activity this month.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>#</TableHead>
                    <TableHead>Admin</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                    <TableHead className="text-right">Share</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {topAdmins.map((admin, i) => {
                    const share =
                      breakdownTotal > 0
                        ? (admin.actionCount / breakdownTotal) * 100
                        : 0;
                    return (
                      <TableRow key={admin.adminUserId}>
                        <TableCell className="font-mono tabular-nums text-xs text-muted-foreground">
                          {i + 1}
                        </TableCell>
                        <TableCell className="font-medium">
                          {admin.username ?? (
                            <span className="text-muted-foreground">
                              (unknown)
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono tabular-nums">
                          {formatNumber(admin.actionCount)}
                        </TableCell>
                        <TableCell className="text-right font-mono tabular-nums text-xs text-muted-foreground">
                          {share.toFixed(1)}%
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </StatPanel>
        </FadeIn>
      </div>

      {/* Session health */}
      <div className="space-y-3">
        <SectionHeading icon={Users} title="Session health" />
        <FadeIn className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <KpiTile
            label="Active Sessions"
            value={formatNumber(sessionHealth.activeSessions)}
            icon={Users}
            accent="blue"
          />
          <KpiTile
            label="Distinct Admins"
            value={formatNumber(sessionHealth.distinctActiveAdmins)}
            sub="Currently online"
            icon={Users}
            accent="purple"
          />
          <KpiTile
            label="Avg Session"
            value={formatMinutes(sessionHealth.avgSessionMinutes)}
            sub="Across terminated sessions"
            icon={Clock}
            accent="cyan"
          />
          <KpiTile
            label="Logouts Today"
            value={formatNumber(sessionHealth.logoutsToday)}
            icon={LogIn}
            accent="rose"
          />
        </FadeIn>
      </div>


      {/* Database sizes */}
      <div className="space-y-3">
        <SectionHeading icon={Database} title="Database sizes" />
        <p className="text-xs text-muted-foreground">
          Approximate row counts from <code className="font-mono">pg_class.reltuples</code>
          . Updated by Postgres autovacuum — may lag behind a live{" "}
          <code className="font-mono">COUNT(*)</code> by a few minutes.
        </p>
        <FadeIn className="grid gap-4 lg:grid-cols-2">
          <StatPanel title="Admin DB" icon={Database} accent="blue">
            <TableRowsTable rows={tableCounts.admin} />
          </StatPanel>
          <StatPanel title="Main DB" icon={Database} accent="emerald">
            <TableRowsTable rows={tableCounts.main} />
          </StatPanel>
        </FadeIn>
      </div>

      {/* Build info */}
      <div className="space-y-3">
        <SectionHeading icon={Server} title="Build info" />
        <FadeIn>
          <StatPanel title="Runtime" icon={Server} accent="purple">
            <div className="grid gap-0 sm:grid-cols-2">
              <PanelRow label="Node version" value={
                <span className="font-mono">{nodeVersion}</span>
              } />
              <PanelRow label="Next.js" value={
                <span className="font-mono">{nextVersion}</span>
              } />
              <PanelRow
                label="Commit SHA"
                value={
                  commitSha ? (
                    <span className="font-mono text-xs">
                      {commitSha.slice(0, 12)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )
                }
              />
              <PanelRow
                label="Deployment ID"
                value={
                  deploymentId ? (
                    <span className="font-mono text-xs">
                      {deploymentId.slice(0, 24)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )
                }
              />
              <PanelRow
                label="Environment"
                value={
                  vercelEnv ? (
                    <span className="font-mono">{vercelEnv}</span>
                  ) : (
                    <span className="font-mono">{process.env.NODE_ENV ?? "dev"}</span>
                  )
                }
              />
              <PanelRow
                label="Region"
                value={
                  vercelRegion ? (
                    <span className="font-mono">{vercelRegion}</span>
                  ) : (
                    <span className="text-muted-foreground">local</span>
                  )
                }
              />
            </div>
          </StatPanel>
        </FadeIn>
      </div>
    </div>
  );
}

function TableRowsTable({
  rows,
}: {
  rows: { table: string; approxCount: number }[];
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Table</TableHead>
          <TableHead className="text-right">Rows (approx)</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.table}>
            <TableCell className="font-mono text-xs">{row.table}</TableCell>
            <TableCell className="text-right font-mono tabular-nums">
              {formatNumber(row.approxCount)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** Format minute counts compactly: "— · 12m · 1h 34m · 2d 3h". */
function formatMinutes(mins: number): string {
  if (!isFinite(mins) || mins <= 0) return "—";
  if (mins < 60) return `${mins.toFixed(0)}m`;
  const hours = Math.floor(mins / 60);
  const remainingMin = Math.round(mins - hours * 60);
  if (hours < 24) {
    return remainingMin === 0 ? `${hours}h` : `${hours}h ${remainingMin}m`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours - days * 24;
  return remHours === 0 ? `${days}d` : `${days}d ${remHours}h`;
}

/**
 * Read the Next.js version without pulling the whole package.json into
 * the bundle. `next/package.json` is a valid entry point (confirmed by
 * Next's own docs). Wrapped in try/catch so a missing field doesn't
 * take down the page.
 */
function readNextVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require("next/package.json") as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}
