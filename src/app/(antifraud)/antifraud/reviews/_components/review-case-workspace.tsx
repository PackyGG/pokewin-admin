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
import {
  formatCurrency,
  formatDateTime,
  formatRelative,
} from "@/lib/utils/format";
import {
  getReviewDetail,
  type ReviewDetail,
  type ReviewDetailResult,
} from "@/lib/antifraud/reviews";
import { ReviewStatusBadge } from "../../_components/badges";
import { QuickReviewActions } from "./quick-review-actions";
import { ReviewSignalBadge } from "./review-signal-badge";
import { LinkedAccountsDialog } from "./linked-accounts-dialog";

/** Complete evidence and controls for the queue's review dialog. */
export async function ReviewCaseWorkspace({
  reviewId,
  detailData,
}: {
  reviewId: string;
  viewerId: string;
  canManage: boolean;
  detailData?: Promise<ReviewDetailResult>;
}) {
  const detail = await (detailData ?? getReviewDetail(reviewId));
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
  const accountCreatedAt = account?.createdAt ?? null;

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
                <span
                  title={accountCreatedAt ? formatDateTime(accountCreatedAt) : undefined}
                >
                  {accountCreatedAt
                    ? `Signed up ${formatRelative(accountCreatedAt)}`
                    : "Signup date unavailable"}
                </span>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 xl:justify-end">
            <LinkedAccountsDialog reviewId={review.id} />
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
  const { review, account, assignee, financialFacts, activeLocks } = detail;
  const facts: { label: string; value: string; mono?: boolean; title?: string }[] =
    [
      { label: "Player id", value: review.targetUserId, mono: true },
      {
        label: "Signed up",
        value: account?.createdAt
          ? formatRelative(account.createdAt)
          : "Unavailable",
        title: account?.createdAt
          ? formatDateTime(account.createdAt)
          : undefined,
      },
      {
        label: "Review opened",
        value: formatRelative(review.createdAt),
        title: formatDateTime(review.createdAt),
      },
      { label: "Assigned to", value: assignee?.label ?? "Unassigned" },
      {
        label: "Fiat deposits",
        value: financialFacts
          ? formatCurrency(financialFacts.fiatDepositsUsd)
          : "Unavailable",
      },
      {
        label: "Crypto deposits",
        value: financialFacts
          ? formatCurrency(financialFacts.cryptoDepositsUsd)
          : "Unavailable",
      },
      {
        label: "Wagered money",
        value: financialFacts
          ? formatCurrency(financialFacts.wageredUsd)
          : "Unavailable",
      },
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
        {activeLocks.length > 0 && (
          <div className="rounded-lg border border-rose-500/25 bg-rose-500/5 p-3 sm:col-span-2 lg:col-span-3">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-rose-700 dark:text-rose-300">
              Active locks
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {activeLocks.map((lock) => (
                <span
                  key={lock}
                  className="rounded-md border border-rose-500/25 bg-background/70 px-2 py-1 text-xs font-medium text-rose-700 dark:text-rose-300"
                >
                  {lock}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function RelatedSignals({ detail }: { detail: ReviewDetail }) {
  const { relatedSignals } = detail;
  if (relatedSignals.length === 0) return null;
  const drivers = relatedSignals.filter((signal) => signal.scoreDelta !== 0).sort(
    (a, b) => (b.scoreDelta ?? 0) - (a.scoreDelta ?? 0),
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

    </section>
  );
}

function CaseTrail({ detail }: { detail: ReviewDetail }) {
  const { notes } = detail;
  return (
    <section className="space-y-3">
      <SectionHeading
        icon={FileText}
        title="Case trail"
      />
      {notes.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/70 px-4 py-7 text-center text-xs text-muted-foreground">
          No notes or activity yet.
        </div>
      ) : (
        <div className="divide-y divide-border/50 overflow-hidden rounded-lg border border-border/60 bg-card">
          {notes.map((note) => (
            <div
              key={note.id}
              className="flex gap-3 px-3 py-3 sm:px-4"
            >
              <span
                className={cn(
                  "mt-1.5 size-2 shrink-0 rounded-full",
                  note.author ? "bg-primary/70" : "bg-muted-foreground/45",
                )}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate text-xs font-semibold">
                    {note.author?.label ?? "System update"}
                  </span>
                  <time
                    className="shrink-0 text-[11px] text-muted-foreground"
                    dateTime={note.createdAt.toISOString()}
                    title={formatDateTime(note.createdAt)}
                  >
                    {formatRelative(note.createdAt)}
                  </time>
                </div>
                <p className="mt-1 whitespace-pre-wrap text-sm leading-5 text-foreground/90">
                  {note.body}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
