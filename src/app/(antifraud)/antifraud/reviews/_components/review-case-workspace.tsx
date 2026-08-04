import { HostLink } from "@/components/host-link";
import {
  Activity,
  FileText,
  ShieldAlert,
  UserRound,
} from "lucide-react";

import { SectionHeading } from "@/components/modern-panels";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatDateTime, formatRelative } from "@/lib/utils/format";
import {
  getReviewDetail,
  REVIEW_STATUS_LABELS,
  isReviewStatus,
  type ReviewDetail,
} from "@/lib/antifraud/reviews";
import { reviewSignalLabel } from "@/lib/antifraud/signal-display";
import { ReviewStatusBadge } from "../../_components/badges";
import { CaseControls } from "./case-controls";
import { QuickReviewActions } from "./quick-review-actions";
import { ReviewSignalBadge } from "./review-signal-badge";
import { listAssignableAnalysts } from "@/lib/antifraud/review-analysts";
import {
  REVIEW_QUEUE_LABELS,
  type ReviewWorkflow,
} from "@/lib/antifraud/review-workflow";
import { RequireKycDialog } from "../../kyc/_components/require-kyc-dialog";


/** Complete evidence and controls for the queue's review dialog. */
export async function ReviewCaseWorkspace({
  reviewId,
  viewerId,
  canManage,
}: {
  reviewId: string;
  viewerId: string;
  canManage: boolean;
}) {
  const [detail, analysts] = await Promise.all([
    getReviewDetail(reviewId),
    listAssignableAnalysts(),
  ]);
  if (detail.kind === "not_found") {
    return (
      <div className="rounded-xl border border-dashed border-border/70 bg-card/40 px-4 py-10 text-center">
        <p className="text-sm font-semibold">Case not found</p>
        <p className="mt-1 text-xs text-muted-foreground">
          It may have been removed or the link is no longer valid.
        </p>
      </div>
    );
  }
  if (detail.kind === "failed") {
    return (
      <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 px-4 py-10 text-center">
        <p className="text-sm font-semibold text-rose-600 dark:text-rose-400">
          Case details could not be loaded
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Close and reopen the review to try again. The queue is still usable.
        </p>
      </div>
    );
  }

  const { review, assignee, notes } = detail.detail;
  const name = review.targetUsername ?? review.targetUserId;

  return (
    <div className="space-y-5">
      {/* ── Identity ─────────────────────────────────────────────── */}
      <div className="rounded-xl border border-border/60 bg-card p-4 sm:p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <Avatar className="size-11">
              <AvatarFallback>{name.slice(0, 2).toUpperCase()}</AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <h1 className="truncate text-lg font-semibold">{name}</h1>
              <p className="truncate font-mono text-xs text-muted-foreground">
                {review.targetUserId}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            <ReviewStatusBadge status={review.status} />
            <Button
              size="sm"
              variant="outline"
              render={
                <HostLink
                  href={`/users/${review.targetUserId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                />
              }
            >
              <UserRound className="size-4" />
              Profile
            </Button>
          </div>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Signed up {formatDateTime(review.createdAt)}
        </p>
      </div>

      {/* ── KPI strip ────────────────────────────────────────────── */}
      <ReviewProgress
        status={review.status}
        assignedTo={assignee?.label ?? null}
        noteCount={notes.length}
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.45fr)_minmax(300px,0.7fr)]">
        <div className="min-w-0 space-y-5">
          <WhyThisCase detail={detail.detail} />
          <CaseFacts detail={detail.detail} />
          <RelatedSignals detail={detail.detail} />
          <CaseTrail detail={detail.detail} />
        </div>
        <aside className="min-w-0 space-y-4 lg:sticky lg:top-0 lg:self-start">
          <CaseControls
            reviewId={review.id}
            status={review.status}
            assignedTo={review.assignedTo}
            viewerId={viewerId}
            analysts={analysts}
          />
          <div className="space-y-3 rounded-xl border border-border/60 bg-card p-4">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Account measures
              </p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Immediate actions. Each asks for confirmation and is audited.
              </p>
            </div>
            <QuickReviewActions
              reviewId={review.id}
              targetUserId={review.targetUserId}
              targetUsername={review.targetUsername}
              status={review.status}
            />
            {canManage &&
              detail.detail.workflow?.evidence.fullyLocked &&
              !detail.detail.workflow.evidence.kycRequired && (
                <RequireKycDialog
                  account={review.targetUserId}
                  accountLabel={name}
                  compact
                />
              )}
          </div>
        </aside>
      </div>
    </div>
  );
}

// ─── Sections ─────────────────────────────────────────────────────────

function ReviewProgress({
  status,
  assignedTo,
  noteCount,
}: {
  status: string;
  assignedTo: string | null;
  noteCount: number;
}) {
  const resolved = status === "cleared" || status === "flagged";
  const reviewing = status === "in_review" || resolved;
  const steps = [
    {
      label: "Inspect",
      detail: "Evidence and account links",
      done: true,
      current: status === "open",
    },
    {
      label: "Review",
      detail: assignedTo
        ? `${assignedTo}${noteCount ? ` · ${noteCount} trail entries` : ""}`
        : "Take the case and record findings",
      done: reviewing,
      current: status === "in_review",
    },
    {
      label: "Decide",
      detail: resolved
        ? isReviewStatus(status)
          ? REVIEW_STATUS_LABELS[status]
          : status
        : "Clear or flag with a conclusion",
      done: resolved,
      current: resolved,
    },
  ];

  return (
    <ol
      className="grid gap-2 rounded-xl border border-border/60 bg-muted/20 p-2 sm:grid-cols-3"
      aria-label="Review progress"
    >
      {steps.map((step, index) => (
        <li
          key={step.label}
          aria-current={step.current ? "step" : undefined}
          className={cn(
            "flex items-start gap-3 rounded-lg px-3 py-2.5",
            step.current && "bg-card shadow-sm ring-1 ring-border",
          )}
        >
          <span
            className={cn(
              "flex size-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-bold",
              step.done
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "border-border bg-background text-muted-foreground",
            )}
          >
            {step.done ? "✓" : index + 1}
          </span>
          <span className="min-w-0">
            <span className="block text-xs font-semibold">{step.label}</span>
            <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">
              {step.detail}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}
/**
 * Signals split by whether they actually moved the score.
 *
 * `riskScore` on a signal row is the *running case total* after that event, so
 * once a case is capped every later row reads the same maxed number — reward
 * bookkeeping written at signup ends up looking as alarming as the rule that
 * opened the case. Ranking on `scoreDelta` (the event's own contribution)
 * separates the drivers from the noise. `scoreDelta === null` means the
 * producer does not score per event, so those stay with the drivers rather
 * than being hidden.
 */
function splitSignals(signals: ReviewDetail["relatedSignals"]) {
  const drivers = signals.filter((s) => s.scoreDelta !== 0);
  const context = signals.filter((s) => s.scoreDelta === 0);
  return {
    drivers: [...drivers].sort(
      (a, b) => (b.scoreDelta ?? 0) - (a.scoreDelta ?? 0),
    ),
    context,
  };
}

function WhyThisCase({ detail }: { detail: ReviewDetail }) {
  const { review } = detail;
  const topDrivers = splitSignals(detail.relatedSignals).drivers
    .filter((signal) => (signal.scoreDelta ?? 0) > 0)
    .slice(0, 5);

  return (
    <section className="space-y-3">
      <SectionHeading
        icon={ShieldAlert}
        title={
          <>
            Why this case exists
            <span className="text-xs font-normal text-muted-foreground">
              reason and rules that fired
            </span>
          </>
        }
      />
      <div className="space-y-3 rounded-xl border border-border/60 bg-card p-4">
        {detail.workflow && (
          <WorkflowEvidence workflow={detail.workflow} />
        )}
        <p className="text-sm leading-relaxed">{review.reason}</p>
        {review.signals.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {review.signals.map((signal) => (
              <ReviewSignalBadge key={signal} signal={signal} />
            ))}
          </div>
        )}
        {topDrivers.length > 0 && (
          <div className="rounded-lg border border-border/60 bg-muted/25 p-3">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              What built the score
            </p>
            <ul className="mt-2 space-y-1.5">
              {topDrivers.map((signal) => (
                <li
                  key={signal.id}
                  className="flex items-start justify-between gap-3"
                >
                  <span className="min-w-0 text-xs leading-5">
                    {reviewSignalLabel(signal.kind)}
                  </span>
                  <ScoreDeltaBadge delta={signal.scoreDelta} />
                </li>
              ))}
            </ul>
          </div>
        )}
        {review.resolution && (
          <p className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs leading-5">
            <span className="font-semibold">Conclusion: </span>
            {review.resolution}
          </p>
        )}
      </div>
    </section>
  );
}

/** The points a single event contributed — not the running case total. */
function ScoreDeltaBadge({ delta }: { delta: number | null }) {
  if (delta == null) {
    return (
      <span className="shrink-0 rounded-sm border border-border/60 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        unscored
      </span>
    );
  }
  return (
    <span
      className={cn(
        "shrink-0 rounded-sm border px-1.5 py-0.5 text-[10px] font-bold tabular-nums",
        delta >= 40
          ? "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400"
          : delta > 0
            ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
            : delta < 0
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              : "border-border/60 text-muted-foreground",
      )}
      title="Points this single event added to the case score"
    >
      {delta > 0 ? `+${delta}` : delta} pts
    </span>
  );
}

function WorkflowEvidence({ workflow }: { workflow: ReviewWorkflow }) {
  const evidence = workflow.evidence;
  const facts = [
    evidence.fullyLocked
      ? "Balance and item withdrawals fully locked"
      : evidence.withdrawalsLocked
        ? "One withdrawal channel is locked"
        : "No withdrawal lock",
    evidence.kycRequired && !evidence.kycFinished
      ? `KYC waiting · ${evidence.kycStatus.replace("_", " ")}`
      : null,
    evidence.kycFinished
      ? `KYC finished · ${evidence.kycStatus}`
      : null,
    evidence.riskScore != null ? `Risk score ${evidence.riskScore}/100` : null,
  ].filter((value): value is string => Boolean(value));

  return (
    <div className="rounded-lg border border-border/60 bg-muted/25 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold">
          {REVIEW_QUEUE_LABELS[workflow.queueState]}
        </p>
        {workflow.postponedUntil && workflow.queueState === "postponed" && (
          <span className="text-[11px] text-muted-foreground">
            Due {formatRelative(workflow.postponedUntil)}
          </span>
        )}
      </div>
      {facts.length > 0 && (
        <ul className="mt-2 grid gap-1 text-[11px] text-muted-foreground sm:grid-cols-2">
          {facts.map((fact) => (
            <li key={fact}>• {fact}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CaseFacts({ detail }: { detail: ReviewDetail }) {
  const { review, assignee } = detail;
  const facts: { label: string; value: string; mono?: boolean; title?: string }[] =
    [
      { label: "Player id", value: review.targetUserId, mono: true },
      {
        label: "Signed up",
        value: formatRelative(review.createdAt),
        title: formatDateTime(review.createdAt),
      },
      { label: "Assigned to", value: assignee?.label ?? "Unassigned" },
    ];
  return (
    <section className="space-y-3">
      <SectionHeading icon={FileText} title="Case facts" />
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {facts.map((fact) => (
          <div
            key={fact.label}
            className="rounded-lg border border-border/60 bg-muted/20 p-2.5"
          >
            <p className="text-[10px] text-muted-foreground">{fact.label}</p>
            <p
              className={cn(
                "mt-0.5 truncate text-xs font-medium tabular-nums",
                fact.mono && "font-mono",
              )}
              title={fact.title ?? fact.value}
            >
              {fact.value}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

function RelatedSignals({ detail }: { detail: ReviewDetail }) {
  const { relatedSignals } = detail;
  if (relatedSignals.length === 0) return null;
  const { drivers, context } = splitSignals(relatedSignals);

  // Zero-score rows repeat heavily (one per daily-reward enrollment), so they
  // collapse into one line per kind with a count instead of eleven rows.
  const grouped = new Map<
    string,
    { kind: string; count: number; latest: Date }
  >();
  for (const signal of context) {
    const existing = grouped.get(signal.kind);
    if (existing) {
      existing.count += 1;
      if (signal.receivedAt > existing.latest) existing.latest = signal.receivedAt;
    } else {
      grouped.set(signal.kind, {
        kind: signal.kind,
        count: 1,
        latest: signal.receivedAt,
      });
    }
  }
  const contextGroups = [...grouped.values()].sort(
    (a, b) => b.latest.getTime() - a.latest.getTime(),
  );

  return (
    <section className="space-y-3">
      <SectionHeading
        icon={Activity}
        title={
          <>
            Signals for this account
            <span className="text-xs font-normal text-muted-foreground">
              latest {relatedSignals.length} · {drivers.length} scored
            </span>
          </>
        }
      />
      {drivers.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/70 bg-card/40 px-4 py-6 text-center text-xs text-muted-foreground">
          None of the recent signals moved the score. The case was opened by the
          reason above.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border/60 bg-card">
          {drivers.map((signal, index) => (
            <div
              key={signal.id}
              className={cn(
                "flex gap-3 p-3 sm:p-4",
                index > 0 && "border-t border-border/60",
              )}
            >
              <div
                className={cn(
                  "mt-1.5 size-2 shrink-0 rounded-full",
                  (signal.scoreDelta ?? 0) >= 40
                    ? "bg-rose-500"
                    : (signal.scoreDelta ?? 0) > 0
                      ? "bg-amber-500"
                      : "bg-cyan-500",
                )}
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <ReviewSignalBadge signal={signal.kind} />
                      <ScoreDeltaBadge delta={signal.scoreDelta} />
                      {signal.riskScore != null && (
                        <span
                          className="text-[10px] tabular-nums text-muted-foreground"
                          title="Running case score after this event"
                        >
                          case {signal.riskScore}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      {signal.summary}
                    </p>
                  </div>
                  <p
                    className="shrink-0 text-[10px] text-muted-foreground"
                    title={formatDateTime(signal.receivedAt)}
                  >
                    {formatRelative(signal.receivedAt)}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {contextGroups.length > 0 && (
        <details className="group overflow-hidden rounded-xl border border-border/60 bg-muted/20">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2.5 text-xs text-muted-foreground hover:bg-muted/40 sm:px-4">
            <span>
              <span className="font-semibold text-foreground">
                {context.length} signal{context.length === 1 ? "" : "s"} with no
                score impact
              </span>{" "}
              — bookkeeping and routine play, kept for the timeline
            </span>
            <span className="shrink-0 text-[10px] uppercase tracking-wide">
              <span className="group-open:hidden">show</span>
              <span className="hidden group-open:inline">hide</span>
            </span>
          </summary>
          <ul className="border-t border-border/60">
            {contextGroups.map((group) => (
              <li
                key={group.kind}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-border/40 px-3 py-2 last:border-b-0 sm:px-4"
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <ReviewSignalBadge signal={group.kind} />
                  {group.count > 1 && (
                    <span className="text-[10px] tabular-nums text-muted-foreground">
                      ×{group.count}
                    </span>
                  )}
                </span>
                <span
                  className="shrink-0 text-[10px] text-muted-foreground"
                  title={formatDateTime(group.latest)}
                >
                  {formatRelative(group.latest)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function CaseTrail({ detail }: { detail: ReviewDetail }) {
  const { notes } = detail;
  return (
    <section className="space-y-3">
      <SectionHeading
        icon={FileText}
        title={
          <>
            Case trail
            <span className="text-xs font-normal text-muted-foreground">
              append-only — notes and system entries
            </span>
          </>
        }
      />
      {notes.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/70 bg-card/40 px-4 py-10 text-center text-xs text-muted-foreground">
          No notes yet. Anything you write is kept permanently — the trail is
          append-only.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border/60 bg-card">
          {notes.map((note, index) => (
            <div
              key={note.id}
              className={cn(
                "p-3 sm:p-4",
                index > 0 && "border-t border-border/60",
              )}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold">
                  {note.author?.label ?? "System"}
                </span>
                <span className="rounded-sm border border-border/60 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {note.kind}
                </span>
                <span
                  className="ml-auto text-[11px] text-muted-foreground"
                  title={formatDateTime(note.createdAt)}
                >
                  {formatRelative(note.createdAt)}
                </span>
              </div>
              <p className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed">
                {note.body}
              </p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
