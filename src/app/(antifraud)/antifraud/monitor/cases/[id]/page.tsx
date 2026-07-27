import { Suspense } from "react";
import { notFound } from "next/navigation";
import {
  Activity,
  ExternalLink,
  FileSearch,
  Flame,
  Gauge,
  History,
  Network,
  RadioTower,
  ScanSearch,
  ShieldAlert,
  UserRoundSearch,
  Workflow,
} from "lucide-react";

import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";
import {
  KpiTile,
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { HostLink } from "@/components/host-link";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatDateTime, formatNumber, formatRelative } from "@/lib/utils/format";
import {
  antifraudDecisionsConfigured,
  getAntifraudCaseDetail,
  MONITOR_CASE_DECISION_LABELS,
  type AntifraudMonitorFlowMatch,
  type AntifraudMonitorProviderCheck,
  type AntifraudMonitorRiskEvent,
  type AntifraudMonitorSession,
  type AntifraudMonitorStaffAction,
  type MonitorCaseDecision,
} from "@/lib/antifraud/monitor-api";
import { isReviewSeverity } from "@/lib/antifraud/constants";
import { ReviewSeverityBadge } from "../../../_components/badges";
import { DecisionPanel } from "./_components/decision-panel";

export const metadata = { title: "Monitor case · Antifraud" };

/**
 * Antifraud → Live monitor → one case.
 *
 * This page closes the analyst loop. The monitor service holds every piece of
 * evidence (signup identity, provider enrichment, the scored event timeline)
 * AND a decision state machine — but until now nothing in the admin could open
 * a case or record a verdict, so an analyst re-keyed the account into the
 * separate review queue and left the monitor case open forever.
 *
 * Left: the evidence, in the order you actually read it — who, from where,
 * what the enrichment said, then what they did and what each action cost them
 * in points. Right: the verdict.
 *
 * Nothing here touches the prod game DB. A verdict is a record; acting on the
 * account still happens on the main dashboard, where it is separately audited.
 *
 * Shell-first: the page heading paints immediately and the case streams in
 * behind its own Suspense boundary, keyed on the case id.
 */
export default async function MonitorCaseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAntifraudPageAccess();
  const { id } = await params;

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={ShieldAlert}
          accent="cyan"
          title="Monitor case"
          subtitle="Case"
        />
      </PageHero>

      <Suspense key={id} fallback={<CaseSkeleton />}>
        <CaseDetail caseId={id} />
      </Suspense>
    </div>
  );
}

async function CaseDetail({ caseId }: { caseId: string }) {
  const result = await getAntifraudCaseDetail(caseId);
  if (!result.configured) {
    return <EmptyState text="The monitor service is not configured." />;
  }
  if (result.notFound) notFound();
  if (result.error || !result.data) {
    return <EmptyState text="This case could not be loaded right now." />;
  }

  const {
    case: subject,
    events,
    providerChecks,
    sessions,
    actions,
    members,
    matches,
  } = result.data;
  const decisionsEnabled = antifraudDecisionsConfigured();
  const activeSession = sessions.find((session) => session.status === "active");
  const location = [subject.city, subject.state, subject.country_code]
    .filter(Boolean)
    .join(", ");

  // Deep-link into the ADMIN-DB review queue with the account already
  // identified, so the two case systems stop being re-keyed by hand.
  const reviewQuery = new URLSearchParams({
    open: "1",
    targetUserId: subject.user_id,
    severity: isReviewSeverity(subject.severity) ? subject.severity : "medium",
    monitorCaseId: subject.id,
    reason:
      `Escalated from monitor case ${subject.id}. ${subject.summary}`.slice(
        0,
        480,
      ),
  });
  if (subject.username) reviewQuery.set("targetUsername", subject.username);

  return (
    <div className="space-y-6">
      {/* ── Score at a glance ─────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile
          label="Current score"
          value={formatNumber(subject.score)}
          sub={subject.severity.toUpperCase()}
          icon={Gauge}
          accent="cyan"
        />
        <KpiTile
          label="Peak score"
          value={formatNumber(subject.peak_score)}
          sub="highest reached"
          icon={Flame}
          accent="rose"
        />
        <KpiTile
          label="Scored events"
          value={formatNumber(events.length)}
          sub={
            matches.length > 0
              ? `${matches.length} matched ${matches.length === 1 ? "flow" : "flows"}`
              : events.length >= 500
                ? "showing first 500"
                : "on this case"
          }
          icon={Activity}
          accent="amber"
        />
        <KpiTile
          label="Monitoring"
          value={activeSession ? "Active" : "Ended"}
          sub={
            activeSession
              ? `until ${formatDateTime(activeSession.ends_at)}`
              : `${sessions.length} session${sessions.length === 1 ? "" : "s"}`
          }
          icon={RadioTower}
          accent={activeSession ? "emerald" : "blue"}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-6">
          {/* ── Subject ─────────────────────────────────────────── */}
          <div className="space-y-3 rounded-xl border border-border/60 bg-card p-4">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-1 truncate text-sm font-semibold">
                {subject.username ?? "Unnamed account"}
              </span>
              <ReviewSeverityBadge severity={subject.severity} />
              <CaseStatusBadge status={subject.status} />
              <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                score {subject.score}
              </span>
            </div>

            <p className="text-sm leading-relaxed">{subject.summary}</p>

            {subject.subject_type === "network" && (
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">
                  <Network className="mr-1 size-3" />
                  {members.length} connected accounts
                </Badge>
                <HostLink
                  href={`/antifraud/networks?user=${encodeURIComponent(subject.user_id)}`}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-cyan-600 hover:underline dark:text-cyan-400"
                >
                  Open network map
                  <ExternalLink className="size-3.5" />
                </HostLink>
              </div>
            )}

            <dl className="grid gap-x-4 gap-y-2 border-t border-border/60 pt-3 text-xs sm:grid-cols-2">
              <Field label="Player id" value={subject.user_id} mono />
              <Field label="Email" value={subject.email ?? "—"} />
              <Field label="Signup IP" value={subject.signup_ip ?? "—"} mono />
              <Field label="Location" value={location || "Unavailable"} />
              <Field
                label="Signed up"
                value={formatRelative(subject.source_created_at)}
                title={formatDateTime(subject.source_created_at)}
              />
              <Field
                label="Case opened"
                value={formatRelative(subject.opened_at)}
                title={formatDateTime(subject.opened_at)}
              />
              <Field label="Assigned to" value={subject.assigned_to ?? "Unassigned"} />
              <Field
                label="Resolved"
                value={
                  subject.resolved_at
                    ? formatRelative(subject.resolved_at)
                    : "—"
                }
                title={
                  subject.resolved_at
                    ? formatDateTime(subject.resolved_at)
                    : undefined
                }
              />
            </dl>

            {subject.resolution && (
              <p className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs">
                <span className="font-semibold">Verdict: </span>
                {decisionLabel(subject.resolution)}
              </p>
            )}

            <HostLink
              href={`/users/${subject.user_id}`}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-cyan-600 hover:underline dark:text-cyan-400"
            >
              <ExternalLink className="size-3.5" />
              Open this player on the main dashboard
            </HostLink>
          </div>

          {subject.subject_type === "network" && members.length > 0 && (
            <div className="space-y-3">
              <SectionHeading
                icon={UserRoundSearch}
                title="Connected accounts"
              />
              <div className="grid gap-2 sm:grid-cols-2">
                {members.slice(0, 100).map((member) => (
                  <HostLink
                    key={member.user_id}
                    href={`/users/${member.user_id}`}
                    className="flex min-w-0 items-center justify-between rounded-lg border border-border/60 bg-card px-3 py-2 text-xs hover:border-cyan-500/40"
                  >
                    <span className="truncate font-medium">
                      {member.username ?? member.user_id}
                    </span>
                    {member.is_root && (
                      <Badge variant="outline" className="ml-2 text-[10px]">
                        Root
                      </Badge>
                    )}
                  </HostLink>
                ))}
              </div>
              {members.length > 100 && (
                <p className="text-xs text-muted-foreground">
                  Showing 100 of {members.length} case members. The network map
                  contains the complete paginated component.
                </p>
              )}
            </div>
          )}

          {/* ── Enrichment ──────────────────────────────────────── */}
          <div className="space-y-3">
            <SectionHeading icon={ScanSearch} title="Enrichment" />
            {providerChecks.length === 0 ? (
              <EmptyState text="No provider checks ran for this account." />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {providerChecks.map((check) => (
                  <ProviderCheckCard key={check.id} check={check} />
                ))}
              </div>
            )}
          </div>

          {matches.length > 0 && (
            <div className="space-y-3">
              <SectionHeading icon={Workflow} title="Matched flows" />
              <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60 bg-card">
                {matches.map((match) => (
                  <FlowMatchRow key={match.id} match={match} />
                ))}
              </ul>
            </div>
          )}

          {/* ── Timeline ────────────────────────────────────────── */}
          <div className="space-y-3">
            <SectionHeading icon={Activity} title="Scored events" />
            {events.length === 0 ? (
              <EmptyState text="Nothing has scored on this case yet." />
            ) : (
              <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60 bg-card">
                {events.map((event) => (
                  <RiskEventRow key={event.id} event={event} />
                ))}
              </ul>
            )}
          </div>

          {/* ── Monitor sessions ────────────────────────────────── */}
          {sessions.length > 0 && (
            <div className="space-y-3">
              <SectionHeading icon={RadioTower} title="Monitor windows" />
              <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60 bg-card">
                {sessions.map((session) => (
                  <SessionRow key={session.id} session={session} />
                ))}
              </ul>
            </div>
          )}

          {/* ── Staff trail ─────────────────────────────────────── */}
          <div className="space-y-3">
            <SectionHeading icon={History} title="Decisions on this case" />
            {actions.length === 0 ? (
              <EmptyState text="No decision has been recorded yet." />
            ) : (
              <ul className="space-y-2">
                {actions.map((action) => (
                  <StaffActionRow key={action.id} action={action} />
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* ── Verdict ───────────────────────────────────────────── */}
        <div className="space-y-4">
          <SectionHeading icon={FileSearch} title="Record a decision" />
          <DecisionPanel
            caseId={subject.id}
            status={subject.status}
            enabled={decisionsEnabled}
          />
          <HostLink
            href={`/antifraud/reviews?${reviewQuery.toString()}`}
            className="inline-flex items-center gap-1.5 px-1 text-xs font-medium text-cyan-600 hover:underline dark:text-cyan-400"
          >
            <UserRoundSearch className="size-3.5" />
            Open a review for this account
          </HostLink>
        </div>
      </div>
    </div>
  );
}

// ─── Rows ────────────────────────────────────────────────────────────────

function FlowMatchRow({ match }: { match: AntifraudMonitorFlowMatch }) {
  return (
    <li className="grid gap-2 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-4">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">{match.rule_name}</span>
          <Badge variant="outline" className="text-[10px]">
            {match.action_type === "escalate" ? "Escalated" : "Manual review"}
          </Badge>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {match.sequence.join(" → ")}
        </p>
        <p className="mt-1 text-[10px] text-muted-foreground">
          Matched {formatDateTime(match.matched_at)}
        </p>
      </div>
      <span
        className={cn(
          "text-sm font-bold tabular-nums",
          match.score_delta < 0
            ? "text-emerald-600 dark:text-emerald-400"
            : "text-rose-600 dark:text-rose-400",
        )}
      >
        {match.score_delta > 0 ? "+" : ""}
        {match.score_delta} pts
      </span>
    </li>
  );
}

function ProviderCheckCard({
  check,
}: {
  check: AntifraudMonitorProviderCheck;
}) {
  const signals = check.signals.filter((signal) => signal.points !== 0);
  return (
    <div className="space-y-2 rounded-xl border border-border/60 bg-card p-3">
      <div className="flex items-center gap-2">
        <Network className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate text-xs font-semibold capitalize">
          {check.provider}
        </span>
        <Badge
          variant="outline"
          className="ml-auto h-5 px-1.5 text-[10px] uppercase tracking-wide"
        >
          {check.status}
        </Badge>
      </div>
      <p className="text-[11px] text-muted-foreground">
        {check.score != null ? `Score ${Math.round(check.score)} · ` : ""}
        <span title={formatDateTime(check.checked_at)}>
          {formatRelative(check.checked_at)}
        </span>
        {check.error_code ? ` · ${check.error_code}` : ""}
      </p>
      {signals.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {signals.map((signal) => (
            <Badge
              key={signal.key}
              variant="outline"
              className={cn(
                "h-5 px-1.5 text-[10px]",
                signal.points > 0
                  ? "border-rose-500/25 bg-rose-500/8 text-rose-600 dark:text-rose-400"
                  : "border-emerald-500/25 bg-emerald-500/8 text-emerald-600 dark:text-emerald-400",
              )}
              title={signal.detail}
            >
              {signal.title} · {signal.points > 0 ? "+" : ""}
              {signal.points}
            </Badge>
          ))}
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground">No signals returned.</p>
      )}
    </div>
  );
}

function RiskEventRow({ event }: { event: AntifraudMonitorRiskEvent }) {
  return (
    <li className="flex items-start gap-3 px-3 py-2.5 sm:px-4">
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="truncate text-xs font-semibold">{event.title}</span>
          <span className="rounded-sm border border-border/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            {event.event_type}
          </span>
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {event.source}
          </span>
        </span>
        {event.detail && (
          <span className="mt-0.5 block text-[11px] text-muted-foreground">
            {event.detail}
          </span>
        )}
      </span>
      <span className="shrink-0 text-right">
        <span
          className={cn(
            "block text-xs font-bold tabular-nums",
            event.score_delta > 0
              ? "text-rose-600 dark:text-rose-400"
              : event.score_delta < 0
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-muted-foreground",
          )}
        >
          {event.score_delta > 0 ? "+" : ""}
          {event.score_delta}
        </span>
        <span className="block text-[10px] text-muted-foreground tabular-nums">
          → {event.score_after}
        </span>
        <span
          className="block text-[10px] text-muted-foreground"
          title={formatDateTime(event.occurred_at)}
        >
          {formatRelative(event.occurred_at)}
        </span>
      </span>
    </li>
  );
}

function SessionRow({ session }: { session: AntifraudMonitorSession }) {
  const active = session.status === "active";
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-xs sm:px-4">
      <Badge
        variant="outline"
        className={cn(
          "h-5 px-1.5 text-[10px] uppercase tracking-wide",
          active &&
            "border-emerald-500/30 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
        )}
      >
        {session.status}
      </Badge>
      <span className="text-muted-foreground">
        started {formatDateTime(session.started_at)}
      </span>
      <span className="text-muted-foreground">
        {active ? "ends" : "ended"}{" "}
        {formatDateTime(session.ended_at ?? session.ends_at)}
      </span>
      <span className="ml-auto tabular-nums text-muted-foreground">
        {session.initial_score} → {session.current_score} (peak{" "}
        {session.peak_score}) · {session.event_count} events
      </span>
    </li>
  );
}

function StaffActionRow({ action }: { action: AntifraudMonitorStaffAction }) {
  return (
    <li className="rounded-lg border border-border/60 bg-card px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold">
          {action.actor_username ?? action.actor_id}
        </span>
        <span className="rounded-sm border border-border/60 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground">
          {decisionLabel(action.action_type)}
        </span>
        <span className="text-[9px] uppercase tracking-wide text-muted-foreground">
          {action.status}
        </span>
        <span
          className="ml-auto text-[11px] text-muted-foreground"
          title={formatDateTime(action.created_at)}
        >
          {formatRelative(action.created_at)}
        </span>
      </div>
      {action.reason && (
        <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed">
          {action.reason}
        </p>
      )}
    </li>
  );
}

// ─── Bits ────────────────────────────────────────────────────────────────

/**
 * Monitor case statuses (`open` / `monitoring` / `in_review` / `escalated` /
 * `resolved`) are the SERVICE's vocabulary, not the review queue's, so they get
 * their own map rather than being forced through `REVIEW_STATUS_COLORS`. These
 * are risk colours, not money colours — nothing here is an amount.
 */
const CASE_STATUS_COLORS: Record<string, string> = {
  open: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  monitoring:
    "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400 border-cyan-500/30",
  in_review:
    "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
  escalated:
    "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30",
  resolved:
    "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
};

function CaseStatusBadge({ status }: { status: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-5 px-1.5 text-[10px] font-bold uppercase tracking-wide",
        CASE_STATUS_COLORS[status] ?? "",
      )}
    >
      {status.replace(/_/g, " ")}
    </Badge>
  );
}

/** `resolution` / `staff_actions.action_type` carry the decision verbatim. */
function decisionLabel(value: string): string {
  return (
    MONITOR_CASE_DECISION_LABELS[value as MonitorCaseDecision] ??
    value.replace(/_/g, " ")
  );
}

function Field({
  label,
  value,
  mono,
  title,
}: {
  label: string;
  value: string;
  mono?: boolean;
  title?: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd
        className={mono ? "truncate font-mono text-[11px]" : "truncate text-xs"}
        title={title ?? value}
      >
        {value}
      </dd>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <p className="rounded-xl border border-dashed border-border/70 bg-card/40 px-4 py-8 text-center text-xs text-muted-foreground">
      {text}
    </p>
  );
}

function CaseSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-24 rounded-xl" />
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-6">
          <Skeleton className="h-64 w-full rounded-xl" />
          <div className="space-y-3">
            <div className="flex items-center gap-2.5">
              <Skeleton className="size-7 rounded-lg" />
              <Skeleton className="h-4 w-28" />
            </div>
            <Skeleton className="h-40 w-full rounded-xl" />
          </div>
          <div className="space-y-3">
            <div className="flex items-center gap-2.5">
              <Skeleton className="size-7 rounded-lg" />
              <Skeleton className="h-4 w-28" />
            </div>
            <Skeleton className="h-64 w-full rounded-xl" />
          </div>
        </div>
        <div className="space-y-4">
          <div className="flex items-center gap-2.5">
            <Skeleton className="size-7 rounded-lg" />
            <Skeleton className="h-4 w-28" />
          </div>
          <Skeleton className="h-96 w-full rounded-xl" />
        </div>
      </div>
    </div>
  );
}
