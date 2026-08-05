import { Suspense } from "react";
import { z } from "zod";
import { HostLink } from "@/components/host-link";
import {
  ArrowUp,
  CheckCircle2,
  ChevronRight,
  Clock3,
  FolderOpen,
  Search,
  ShieldAlert,
  UserCheck,
  UserRound,
} from "lucide-react";

import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";
import { safeQuery } from "@/lib/errors/safe-query";
import {
  KpiTile,
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatDateTime, formatRelative } from "@/lib/utils/format";
import {
  getReviewQueueStats,
  getReviewIdForMonitorCase,
  listReviewPage,
  REVIEW_PAGE_SIZE,
  isReviewStatus,
  type ReviewFilters,
  type ReviewListItem,
} from "@/lib/antifraud/reviews";
import {
  REVIEW_QUEUE_LABELS,
  REVIEW_QUEUE_STATES,
  type ReviewQueueState,
} from "@/lib/antifraud/review-workflow";
import { canManageAntifraud } from "@/lib/antifraud/access";
import { FilterButton, FilterGroup } from "../_components/list-page";
import { ReviewStatusBadge } from "../_components/badges";
import { OpenCaseDialog } from "./_components/open-case-dialog";
import { ReviewCaseDialog } from "./_components/review-case-dialog";
import { ReviewCaseWorkspace } from "./_components/review-case-workspace";
import { ReviewOpenButton } from "./_components/review-open-button";
import { ReviewSignalBadge } from "./_components/review-signal-badge";

export const metadata = { title: "Account Review" };

/**
 * Antifraud → Account Review.
 *
 * The case queue. Filters and the selected review are URL-driven, so search,
 * paging, dialog state, and direct links stay shareable. Review details stream
 * into an accessible dialog without replacing the queue underneath it.
 *
 * Shell-first: the hero + filter bar paint immediately, the KPI strip and the
 * list stream behind their own Suspense boundary keyed on the active filter so
 * switching filters shows a skeleton instead of a stale list.
 */

const QUERY_TIMEOUT_MS = 10_000;

type SearchParams = {
  tab?: string;
  status?: string;
  q?: string;
  cursor?: string;
  open?: string;
  targetUserId?: string;
  targetUsername?: string;
  reason?: string;
  monitorCaseId?: string;
  review?: string;
};

export default async function ReviewQueuePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await requireAntifraudPageAccess();
  const params = await searchParams;

  const status =
    params.status === "all"
      ? "all"
      : params.status && isReviewStatus(params.status)
        ? params.status
        : "unresolved";
  const tab = (REVIEW_QUEUE_STATES as readonly string[]).includes(
    params.tab ?? "",
  )
    ? (params.tab as ReviewQueueState)
    : "priority";
  const search = params.q?.trim() || undefined;
  const cursor = params.cursor?.trim() || undefined;
  const directReviewId = z.string().uuid().safeParse(params.review).success
    ? params.review
    : undefined;
  const monitorCaseId = z.string().uuid().safeParse(params.monitorCaseId).success
    ? params.monitorCaseId
    : undefined;
  const selectedReviewId =
    directReviewId ??
    (monitorCaseId
      ? (await getReviewIdForMonitorCase(monitorCaseId)) ?? undefined
      : undefined);

  const filters: ReviewFilters = {
    status,
    queue: tab,
    search,
    limit: REVIEW_PAGE_SIZE,
  };

  const filterKey = `${tab}-${status}-${search ?? ""}-${cursor ?? "first"}`;
  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity />
      </PageHero>

      <FilterBar
        tab={tab}
        status={status}
        search={search}
        openCaseProps={{
          prefill: {
            targetUserId: params.targetUserId,
            targetUsername: params.targetUsername,
            reason: params.reason,
            monitorCaseId: params.monitorCaseId,
          },
          autoOpen: params.open === "1",
        }}
      />

      <Suspense key={filterKey} fallback={<QueueSkeleton />}>
        <QueueList
          filters={filters}
          cursor={cursor}
          current={{ tab, status, q: search, cursor }}
          selectedReviewId={selectedReviewId}
          viewerId={session.userId}
          canManage={canManageAntifraud(session)}
        />
      </Suspense>
    </div>
  );
}

// ─── Filters ──────────────────────────────────────────────────────────

function buildHref(next: Partial<SearchParams>, current: SearchParams): string {
  const merged = { ...current, ...next };
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(merged)) {
    if (value && value !== "") query.set(key, value);
  }
  const qs = query.toString();
  return qs ? `/antifraud/reviews?${qs}` : "/antifraud/reviews";
}

function FilterBar({
  tab,
  status,
  search,
  openCaseProps,
}: {
  tab: ReviewQueueState;
  status: string;
  search?: string;
  openCaseProps: React.ComponentProps<typeof OpenCaseDialog>;
}) {
  const current: SearchParams = {
    tab,
    status,
    q: search,
  };

  return (
    <div className="rounded-xl border border-border/70 bg-card p-3 sm:p-4">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
        <FilterGroup label="Queue">
          {REVIEW_QUEUE_STATES.map((value) => (
            <FilterButton
              key={value}
              href={buildHref(
                { tab: value, status: "unresolved", cursor: undefined },
                current,
              )}
              active={tab === value}
              label={REVIEW_QUEUE_LABELS[value]}
            />
          ))}
        </FilterGroup>
        <div className="flex w-full flex-wrap items-center gap-2 xl:w-auto xl:flex-nowrap">
          {/* GET form — no client JS, and the URL stays shareable. */}
          <form className="flex min-w-0 flex-1 gap-2">
            <input type="hidden" name="tab" value={tab} />
            {status && <input type="hidden" name="status" value={status} />}
            <Input
              type="search"
              name="q"
              defaultValue={search ?? ""}
              maxLength={100}
              placeholder="Username, player id or reason…"
              aria-label="Search cases"
              className="min-w-0 flex-1 xl:w-64"
            />
            <Button type="submit" variant="outline" aria-label="Search">
              <Search className="size-4" />
            </Button>
          </form>
          <OpenCaseDialog {...openCaseProps} />
        </div>
      </div>
    </div>
  );
}

// ─── List ─────────────────────────────────────────────────────────────

async function QueueList({
  filters,
  cursor,
  current,
  selectedReviewId,
  viewerId,
  canManage,
}: {
  filters: ReviewFilters;
  cursor?: string;
  current: SearchParams;
  selectedReviewId?: string;
  viewerId: string;
  canManage: boolean;
}) {
  const { data, error } = await safeQuery(
    async () => {
      const [page, stats] = await Promise.all([
        listReviewPage(filters, cursor),
        getReviewQueueStats(),
      ]);
      return { page, stats };
    },
    {
      page: { items: [], nextCursor: null, total: 0 },
      stats: {
        priority: 0,
        normal: 0,
        waitingKyc: 0,
        postponed: 0,
      },
    },
    "antifraud.review-queue",
    QUERY_TIMEOUT_MS,
  );
  const { page, stats } = data;
  const reviews = page.items;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile
          icon={ShieldAlert}
          accent="rose"
          label="High priority"
          value={stats.priority.toLocaleString()}
          sub="locked, finished KYC, or 70+"
        />
        <KpiTile
          icon={FolderOpen}
          accent="blue"
          label="Normal"
          value={stats.normal.toLocaleString()}
          sub="unusual score, no full lock"
        />
        <KpiTile
          icon={Clock3}
          accent="amber"
          label="Waiting KYC"
          value={stats.waitingKyc.toLocaleString()}
          sub="provider result pending"
        />
        <KpiTile
          icon={Clock3}
          accent="cyan"
          label="Postponed"
          value={stats.postponed.toLocaleString()}
          sub="hidden until due"
        />
      </div>

      <SectionHeading
        icon={ShieldAlert}
        title={
          <>
            Cases
            <span className="text-xs font-normal tabular-nums text-muted-foreground">
              ({reviews.length} of {page.total})
            </span>
          </>
        }
      />

      {error ? (
        <div className="rounded-xl border border-dashed border-rose-500/30 bg-rose-500/5 px-4 py-10 text-center">
          <p className="text-sm font-semibold text-rose-600 dark:text-rose-400">
            Cases could not be loaded
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            The review database did not answer. Refresh to try again.
          </p>
        </div>
      ) : reviews.length === 0 ? (
        <div className="flex flex-col items-center gap-1.5 rounded-xl border border-dashed border-border/70 bg-card/40 px-4 py-14 text-center">
          <CheckCircle2 className="size-6 text-muted-foreground" />
          <span className="text-sm font-semibold">Nothing here</span>
          <span className="max-w-sm text-xs text-muted-foreground">
            No cases match this filter. Cases arrive automatically from the
            fraud backend, or you can open one with the button above.
          </span>
        </div>
      ) : (
        <ul className="space-y-3">
          {reviews.map((review) => (
            <CaseRow
              key={review.id}
              review={review}
              current={current}
              viewerId={viewerId}
            />
          ))}
        </ul>
      )}

      {!error && (cursor || page.nextCursor) && (
        <nav
          aria-label="Review queue pages"
          className="flex flex-wrap items-center justify-between gap-2"
        >
          {cursor ? (
            <Button
              size="sm"
              variant="outline"
              render={<HostLink href={buildHref({ cursor: undefined }, current)} />}
            >
              <ArrowUp className="size-3.5" />
              Back to newest
            </Button>
          ) : (
            <span />
          )}
          {page.nextCursor && (
            <Button
              size="sm"
              variant="outline"
              render={
                <HostLink href={buildHref({ cursor: page.nextCursor }, current)} />
              }
            >
              Older cases
              <ChevronRight className="size-3.5" />
            </Button>
          )}
        </nav>
      )}

      {selectedReviewId && (
        <ReviewDialogFromQueue
          reviewId={selectedReviewId}
          reviews={reviews}
          current={current}
          viewerId={viewerId}
          canManage={canManage}
        />
      )}
    </div>
  );
}

function CaseRow({
  review,
  current,
  viewerId,
}: {
  review: ReviewListItem;
  current: SearchParams;
  viewerId: string;
}) {
  const name = review.targetUsername ?? review.targetUserId;
  return (
    <li className="rounded-xl border border-border/70 bg-card shadow-sm">
      <div className="flex flex-col gap-3 p-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <Avatar className="size-10 shrink-0">
            <AvatarFallback>{name.slice(0, 2).toUpperCase()}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="truncate text-sm font-semibold">{name}</span>
              <ReviewStatusBadge status={review.status} />
              {review.assignee && (
                <span className="inline-flex items-center gap-1 rounded-sm border border-cyan-500/30 bg-cyan-500/5 px-1.5 py-0.5 text-[10px] font-semibold text-cyan-700 dark:text-cyan-300">
                  <UserCheck className="size-3" />
                  {review.assignee.label}
                </span>
              )}
              {review.workflow && (
                <span className="rounded-sm border border-border/60 px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                  {REVIEW_QUEUE_LABELS[review.workflow.queueState]}
                </span>
              )}
              {review.riskScore != null && (
                <span
                  className={cn(
                    "rounded-sm border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide",
                    review.riskScore >= 60
                      ? "border-rose-500/30 text-rose-600 dark:text-rose-400"
                      : review.riskScore >= 30
                        ? "border-amber-500/30 text-amber-600 dark:text-amber-400"
                        : "border-border/60 text-muted-foreground",
                  )}
                >
                  risk {review.riskScore}
                </span>
              )}
            </div>
            <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground">
              {review.reason}
            </p>
            {review.signals.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {review.signals.slice(0, 4).map((signal) => (
                  <ReviewSignalBadge key={signal} signal={signal} />
                ))}
                {review.signals.length > 4 && (
                  <span className="text-[10px] text-muted-foreground">
                    +{review.signals.length - 4} more
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-3 lg:justify-end">
          <div className="text-left lg:text-right">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Opened by{" "}
              {review.opener?.label ??
                (review.openedBy ? "Unknown staff" : "Antifraud monitor")}
            </p>
            <p
              className="text-xs font-medium tabular-nums"
              title={formatDateTime(review.createdAt)}
            >
              {formatRelative(review.createdAt)}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <HostLink
              href={`/users/${review.targetUserId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-xs font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Open profile of ${review.targetUsername ?? review.targetUserId} in a new tab`}
            >
              <UserRound className="size-3.5" />
              Profile
            </HostLink>
            <ReviewOpenButton
              reviewId={review.id}
              viewerId={viewerId}
              status={review.status}
              href={buildHref({ review: review.id }, current)}
              label={review.targetUsername ?? review.targetUserId}
            />
          </div>
        </div>
      </div>
    </li>
  );
}

function ReviewDialogFromQueue({
  reviewId,
  reviews,
  current,
  viewerId,
  canManage,
}: {
  reviewId: string;
  reviews: ReviewListItem[];
  current: SearchParams;
  viewerId: string;
  canManage: boolean;
}) {
  const index = reviews.findIndex((review) => review.id === reviewId);
  const previous = index > 0 ? reviews[index - 1] : undefined;
  const next = index >= 0 ? reviews[index + 1] : undefined;
  const closeHref = buildHref({ review: undefined }, current);

  return (
    <ReviewCaseDialog
      key={reviewId}
      closeHref={closeHref}
      previousHref={
        previous ? buildHref({ review: previous.id }, current) : undefined
      }
      nextHref={next ? buildHref({ review: next.id }, current) : undefined}
    >
      <Suspense key={reviewId} fallback={<CaseDialogSkeleton />}>
        <ReviewCaseWorkspace
          reviewId={reviewId}
          viewerId={viewerId}
          canManage={canManage}
        />
      </Suspense>
    </ReviewCaseDialog>
  );
}

function CaseDialogSkeleton() {
  return (
    <div className="space-y-5">
      <Skeleton className="h-24 w-full rounded-xl" />
      <Skeleton className="h-16 w-full rounded-xl" />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.45fr)_minmax(300px,0.7fr)]">
        <div className="space-y-5">
          <Skeleton className="h-40 w-full rounded-xl" />
          <Skeleton className="h-48 w-full rounded-xl" />
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
        <Skeleton className="h-96 w-full rounded-xl" />
      </div>
    </div>
  );
}

function QueueSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
      </div>
      <div className="flex items-center gap-2.5">
        <Skeleton className="size-7 rounded-lg" />
        <Skeleton className="h-4 w-32" />
      </div>
      <div className="space-y-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full rounded-xl" />
        ))}
      </div>
    </div>
  );
}
