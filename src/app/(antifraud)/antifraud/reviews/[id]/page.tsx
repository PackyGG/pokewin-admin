import { Suspense } from "react";
import { notFound } from "next/navigation";
import { HostLink } from "@/components/host-link";
import {
  Activity,
  ExternalLink,
  FileText,
  ShieldAlert,
  User,
} from "lucide-react";

import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateTime, formatRelative } from "@/lib/utils/format";
import { getReviewDetail } from "@/lib/antifraud/reviews";
import { ReviewSeverityBadge, ReviewStatusBadge } from "../../_components/badges";
import { CaseControls } from "../_components/case-controls";
import { listAssignableAnalysts } from "../actions";

export const metadata = { title: "Case" };

/**
 * Antifraud → Account Review → one case.
 *
 * Left: the case itself — who it is about, why, which rules fired, and the full
 * append-only trail (analyst notes AND system entries). Right: the controls.
 *
 * The "open in the main dashboard" link is the ONLY route from here to an
 * action on the account: this workspace records verdicts, the main dashboard
 * performs the (separately audited) mutations. That is what keeps the prod game
 * DB read-only from here.
 *
 * Shell-first: the back affordance paints immediately and the case streams in
 * behind its own Suspense boundary (loading.tsx renders the matching skeleton
 * on a hard navigation). Keyed on the case id so moving between cases shows a
 * skeleton rather than the previous case's data.
 */
export default async function ReviewDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireAntifraudPageAccess();
  const { id } = await params;

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={ShieldAlert}
          accent="cyan"
          title="Account review"
          subtitle="Case"
          backHref="/antifraud/reviews"
        />
      </PageHero>

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

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="space-y-6">
        {/* ── Case summary ──────────────────────────────────────── */}
        <div className="space-y-3 rounded-xl border border-border/60 bg-card p-4">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 truncate text-sm font-semibold">
              {review.targetUsername ?? review.targetUserId}
            </span>
            <ReviewSeverityBadge severity={review.severity} />
            <ReviewStatusBadge status={review.status} />
            {review.riskScore != null && (
              <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                risk {review.riskScore}
              </span>
            )}
            <span className="rounded-sm border border-border/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              {review.source}
            </span>
          </div>

          <p className="text-sm leading-relaxed">{review.reason}</p>

          {review.signals.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {review.signals.map((signal) => (
                <span
                  key={signal}
                  className="rounded-sm border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground"
                >
                  {signal}
                </span>
              ))}
            </div>
          )}

          <dl className="grid gap-x-4 gap-y-2 border-t border-border/60 pt-3 text-xs sm:grid-cols-2">
            <Field label="Player id" value={review.targetUserId} mono />
            <Field
              label="Opened"
              value={`${formatRelative(review.createdAt)}${
                opener ? ` by ${opener.label}` : ""
              }`}
              title={formatDateTime(review.createdAt)}
            />
            <Field label="Assigned to" value={assignee?.label ?? "Unassigned"} />
            <Field
              label="Resolved"
              value={
                review.resolvedAt
                  ? `${formatRelative(review.resolvedAt)}${
                      resolver ? ` by ${resolver.label}` : ""
                    }`
                  : "—"
              }
            />
          </dl>

          {review.resolution && (
            <p className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs">
              <span className="font-semibold">Conclusion: </span>
              {review.resolution}
            </p>
          )}

          {/* The bridge to the surfaces that can actually act on the
              account. Opens the main dashboard's user page. */}
          <HostLink
            href={`/users/${review.targetUserId}`}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-cyan-600 hover:underline dark:text-cyan-400"
          >
            <ExternalLink className="size-3.5" />
            Open this player on the main dashboard
          </HostLink>
        </div>

        {/* ── Related signals ───────────────────────────────────── */}
        {relatedSignals.length > 0 && (
          <div className="space-y-3">
            <SectionHeading icon={Activity} title="Signals for this account" />
            <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60 bg-card">
              {relatedSignals.map((signal) => (
                <li
                  key={signal.id}
                  className="flex items-start gap-3 px-3 py-2.5 sm:px-4"
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate text-xs font-semibold">
                        {signal.kind}
                      </span>
                      <ReviewSeverityBadge severity={signal.severity} />
                      {signal.riskScore != null && (
                        <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                          risk {signal.riskScore}
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block text-[11px] text-muted-foreground">
                      {signal.summary}
                    </span>
                  </span>
                  <span
                    className="shrink-0 text-[11px] text-muted-foreground"
                    title={formatDateTime(signal.receivedAt)}
                  >
                    {formatRelative(signal.receivedAt)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* ── Trail ─────────────────────────────────────────────── */}
        <div className="space-y-3">
          <SectionHeading icon={FileText} title="Case trail" />
          {notes.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border/70 bg-card/40 px-4 py-8 text-center text-xs text-muted-foreground">
              No notes yet. Anything you write is kept permanently — the trail
              is append-only.
            </p>
          ) : (
            <ul className="space-y-2">
              {notes.map((note) => (
                <li
                  key={note.id}
                  className="rounded-lg border border-border/60 bg-card px-3 py-2.5"
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
                  <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed">
                    {note.body}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* ── Controls ───────────────────────────────────────────── */}
      <div className="space-y-4">
        <SectionHeading icon={User} title="Work this case" />
        <CaseControls
          reviewId={review.id}
          status={review.status}
          severity={review.severity}
          assignedTo={review.assignedTo}
          viewerId={viewerId}
          analysts={analysts}
        />
      </div>
    </div>
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

function CaseSkeleton() {
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="space-y-6">
        <Skeleton className="h-64 w-full rounded-xl" />
        <div className="space-y-3">
          <div className="flex items-center gap-2.5">
            <Skeleton className="size-7 rounded-lg" />
            <Skeleton className="h-4 w-28" />
          </div>
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full rounded-lg" />
          ))}
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
  );
}
