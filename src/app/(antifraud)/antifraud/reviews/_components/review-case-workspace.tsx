import { HostLink } from "@/components/host-link";
import {
  Activity,
  FileText,
  Mail,
  MapPin,
  UserRound,
} from "lucide-react";

import { SectionHeading } from "@/components/modern-panels";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatDateTime, formatRelative } from "@/lib/utils/format";
import {
  getReviewDetail,
  type ReviewDetail,
} from "@/lib/antifraud/reviews";
import { ReviewStatusBadge } from "../../_components/badges";
import { QuickReviewActions } from "./quick-review-actions";
import { ReviewSignalBadge } from "./review-signal-badge";

/** Complete evidence and controls for the queue's review dialog. */
export async function ReviewCaseWorkspace({
  reviewId,
}: {
  reviewId: string;
  viewerId: string;
  canManage: boolean;
}) {
  const detail = await getReviewDetail(reviewId);
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

  const { review, account } = detail.detail;
  const name = review.targetUsername ?? review.targetUserId;
  const country = account?.country ?? account?.countryCode ?? "Country unavailable";

  return (
    <div className="space-y-4">
      {/* ── Identity ─────────────────────────────────────────────── */}
      <div className="rounded-xl border border-border/60 bg-card p-3">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <Avatar className="size-10">
              <AvatarFallback>{name.slice(0, 2).toUpperCase()}</AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <h1 className="truncate text-base font-semibold">{name}</h1>
                <ReviewStatusBadge status={review.status} />
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                <span className="font-mono">{review.targetUserId}</span>
                <span className="inline-flex items-center gap-1">
                  <Mail className="size-3" />
                  {account?.email ?? "Email unavailable"}
                </span>
                <span className="inline-flex items-center gap-1">
                  <MapPin className="size-3" />
                  {country}
                </span>
                <span title={formatDateTime(review.createdAt)}>
                  Signed up {formatRelative(review.createdAt)}
                </span>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 xl:justify-end">
            <QuickReviewActions
              reviewId={review.id}
              targetUserId={review.targetUserId}
              targetUsername={review.targetUsername}
              status={review.status}
              compact
            />
            <Button
              size="sm"
              variant="outline"
              className="h-8 px-2.5 text-xs"
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
      </div>

      {/* ── KPI strip ────────────────────────────────────────────── */}
      <div className="min-w-0 space-y-5">
        <CaseFacts detail={detail.detail} />
        <RelatedSignals detail={detail.detail} />
        <CaseTrail detail={detail.detail} />
      </div>
    </div>
  );
}

// ─── Sections ─────────────────────────────────────────────────────────

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
