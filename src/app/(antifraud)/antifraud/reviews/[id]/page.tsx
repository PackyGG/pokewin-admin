import { Suspense } from "react";
import { notFound } from "next/navigation";
import { z } from "zod";
import { HostLink } from "@/components/host-link";
import {
  Activity,
  Clock3,
  FileText,
  Gauge,
  Network,
  ShieldAlert,
  UserRound,
} from "lucide-react";

import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";
import {
  KpiTile,
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { PageHeroSkeleton } from "@/components/loading-skeletons";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatDateTime, formatRelative } from "@/lib/utils/format";
import {
  getReviewDetail,
  REVIEW_STATUS_LABELS,
  isReviewStatus,
  type ReviewDetail,
} from "@/lib/antifraud/reviews";
import { ReviewStatusBadge } from "../../_components/badges";
import { CaseControls } from "../_components/case-controls";
import { QuickReviewActions } from "../_components/quick-review-actions";
import { ReviewSignalBadge } from "../_components/review-signal-badge";
import { listAssignableAnalysts } from "../actions";

export const metadata = { title: "Case" };

/**
 * Antifraud → Account Review → one case.
 *
 * Left: the case itself — who it is about, why, which rules fired, and the full
 * append-only trail (analyst notes AND system entries). Right: the controls.
 *
 * Quick account actions are capability-gated and separately audited. The main
 * dashboard link remains available for the complete account toolset.
 *
 * Shell-first: the skeleton (hero included) paints immediately and the case
 * streams in behind its own Suspense boundary (loading.tsx renders the same
 * skeleton on a hard navigation). Keyed on the case id so moving between cases
 * shows a skeleton rather than the previous case's data. The hero lives inside
 * the streamed part because its action slot needs the target user id.
 */
export default async function ReviewDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireAntifraudPageAccess();
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();

  return (
    <div className="space-y-6">
      <Suspense key={id} fallback={<CaseSkeleton />}>
        <CaseDetail reviewId={id} viewerId={session.userId} />
      </Suspense>
    </div>
  );
}

async function CaseDetail({
  reviewId,
  viewerId,
}: {
  reviewId: string;
  viewerId: string;
}) {
  const [detail, analysts] = await Promise.all([
    getReviewDetail(reviewId),
    listAssignableAnalysts(),
  ]);
  if (detail.kind === "not_found") notFound();
  if (detail.kind === "failed") {
    // Throw into the route's error boundary. A database outage is not a 404,
    // and rendering "case not found" would falsely imply that data vanished.
    throw new Error("The case database could not be reached.");
  }

  const { review, assignee, opener, resolver, notes, relatedSignals } =
    detail.detail;
  const name = review.targetUsername ?? review.targetUserId;

  return (
    <>
      <PageHero>
        <PageHeroIdentity
          icon={ShieldAlert}
          accent="cyan"
          title="Account review"
          subtitle="Case"
          backHref="/antifraud/reviews"
          action={
            <>
              <Button
                size="sm"
                variant="outline"
                render={<HostLink href={`/users/${review.targetUserId}`} />}
              >
                <UserRound className="size-4" />
                User profile
              </Button>
              <Button
                size="sm"
                variant="outline"
                render={
                  <HostLink
                    href={`/antifraud/networks?user=${encodeURIComponent(review.targetUserId)}`}
                  />
                }
              >
                <Network className="size-4" />
                Account network
              </Button>
            </>
          }
        />
      </PageHero>

      {/* ── Identity ─────────────────────────────────────────────── */}
      <div className="rounded-xl border bg-card p-4 sm:p-5">
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
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="capitalize">
              {review.source}
            </Badge>
            <ReviewStatusBadge status={review.status} />
          </div>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Opened {formatDateTime(review.createdAt)}
          {opener ? ` by ${opener.label}` : ""} · last updated{" "}
          {formatRelative(review.updatedAt)}
        </p>
      </div>

      {/* ── KPI strip ────────────────────────────────────────────── */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile
          icon={Clock3}
          accent="cyan"
          label="Review state"
          value={
            isReviewStatus(review.status)
              ? REVIEW_STATUS_LABELS[review.status]
              : review.status
          }
          sub={assignee ? `assigned to ${assignee.label}` : "unassigned"}
        />
        <KpiTile
          icon={Gauge}
          accent={riskAccent(review.riskScore)}
          label="Risk score"
          value={review.riskScore != null ? `${review.riskScore}/100` : "—"}
          sub={
            review.riskScore != null
              ? "backend risk at open"
              : "no automated score"
          }
        />
        <KpiTile
          icon={Activity}
          accent={relatedSignals.length > 0 ? "amber" : "emerald"}
          label="Account signals"
          value={String(relatedSignals.length)}
          sub={
            relatedSignals.length > 0
              ? "recent signals for this account"
              : "no other signals on record"
          }
        />
        <KpiTile
          icon={FileText}
          accent="blue"
          label="Trail entries"
          value={String(notes.length)}
          sub={
            review.resolvedAt
              ? `resolved ${formatRelative(review.resolvedAt)}`
              : "append-only case trail"
          }
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,0.7fr)]">
        <div className="min-w-0 space-y-6">
          <WhyThisCase detail={detail.detail} />
          <CaseFacts detail={detail.detail} resolver={resolver} />
          <RelatedSignals detail={detail.detail} />
          <CaseTrail detail={detail.detail} />
        </div>
        <aside className="min-w-0 space-y-5">
          <div className="space-y-3 rounded-xl border bg-card p-4">
            <p className="text-sm font-semibold">Account actions</p>
            <p className="text-xs leading-5 text-muted-foreground">
              One-click account measures. Each one is confirmed and separately
              audited.
            </p>
            <QuickReviewActions
              reviewId={review.id}
              targetUserId={review.targetUserId}
              targetUsername={review.targetUsername}
              status={review.status}
            />
          </div>
          <CaseControls
            reviewId={review.id}
            status={review.status}
            assignedTo={review.assignedTo}
            viewerId={viewerId}
            analysts={analysts}
          />
        </aside>
      </div>
    </>
  );
}

// ─── Sections ─────────────────────────────────────────────────────────

function WhyThisCase({ detail }: { detail: ReviewDetail }) {
  const { review } = detail;
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
      <div className="space-y-3 rounded-xl border bg-card p-4">
        <p className="text-sm leading-relaxed">{review.reason}</p>
        {review.signals.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {review.signals.map((signal) => (
              <ReviewSignalBadge key={signal} signal={signal} />
            ))}
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

function CaseFacts({
  detail,
  resolver,
}: {
  detail: ReviewDetail;
  resolver: ReviewDetail["resolver"];
}) {
  const { review, assignee, opener } = detail;
  const facts: { label: string; value: string; mono?: boolean; title?: string }[] =
    [
      { label: "Player id", value: review.targetUserId, mono: true },
      { label: "Source", value: review.source },
      {
        label: "Opened",
        value: `${formatRelative(review.createdAt)}${
          opener ? ` by ${opener.label}` : ""
        }`,
        title: formatDateTime(review.createdAt),
      },
      { label: "Assigned to", value: assignee?.label ?? "Unassigned" },
      {
        label: "Resolved",
        value: review.resolvedAt
          ? `${formatRelative(review.resolvedAt)}${
              resolver ? ` by ${resolver.label}` : ""
            }`
          : "Not resolved yet",
        title: review.resolvedAt ? formatDateTime(review.resolvedAt) : undefined,
      },
      {
        label: "Last updated",
        value: formatRelative(review.updatedAt),
        title: formatDateTime(review.updatedAt),
      },
    ];
  return (
    <section className="space-y-3">
      <SectionHeading icon={FileText} title="Case facts" />
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {facts.map((fact) => (
          <div key={fact.label} className="rounded-lg border bg-card p-3">
            <p className="text-[11px] text-muted-foreground">{fact.label}</p>
            <p
              className={cn(
                "mt-1 truncate text-sm font-semibold",
                fact.mono && "font-mono text-xs",
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
  return (
    <section className="space-y-3">
      <SectionHeading
        icon={Activity}
        title={
          <>
            Signals for this account
            <span className="text-xs font-normal text-muted-foreground">
              latest {relatedSignals.length}
            </span>
          </>
        }
      />
      <div className="overflow-hidden rounded-xl border bg-card">
        {relatedSignals.map((signal, index) => (
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
                signal.riskScore != null && signal.riskScore >= 60
                  ? "bg-rose-500"
                  : signal.riskScore != null && signal.riskScore >= 30
                    ? "bg-amber-500"
                    : "bg-cyan-500",
              )}
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <ReviewSignalBadge signal={signal.kind} />
                    {signal.riskScore != null && (
                      <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                        risk {signal.riskScore}
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
        <div className="rounded-xl border border-dashed bg-card/40 px-4 py-10 text-center text-xs text-muted-foreground">
          No notes yet. Anything you write is kept permanently — the trail is
          append-only.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
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
                <span className="rounded-sm border border-border/60 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground">
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

function riskAccent(score: number | null): "emerald" | "amber" | "rose" | "cyan" {
  if (score === null) return "cyan";
  if (score >= 60) return "rose";
  if (score >= 30) return "amber";
  return "emerald";
}

function CaseSkeleton() {
  return (
    <>
      <PageHeroSkeleton action />
      <Skeleton className="h-24 w-full rounded-xl" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
      </div>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,0.7fr)]">
        <div className="space-y-6">
          <Skeleton className="h-40 w-full rounded-xl" />
          <Skeleton className="h-32 w-full rounded-xl" />
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
        <div className="space-y-5">
          <Skeleton className="h-32 w-full rounded-xl" />
          <Skeleton className="h-96 w-full rounded-xl" />
        </div>
      </div>
    </>
  );
}
