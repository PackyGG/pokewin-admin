import { Suspense } from "react";
import { z } from "zod";
import { HostLink } from "@/components/host-link";
import {
  ArrowUp,
  CheckCircle2,
  ChevronRight,
  Eye,
  Search,
  ShieldAlert,
  ShieldCheck,
  UserCheck,
  UserRound,
} from "lucide-react";

import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";
import { safeQuery } from "@/lib/errors/safe-query";
import {
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
  getAccountReviewTabCounts,
  getReviewDetail,
  getReviewIdForMonitorCase,
  listReviewPage,
  REVIEW_PAGE_SIZE,
  type ReviewFilters,
  type ReviewListItem,
} from "@/lib/antifraud/reviews";
import { canManageAntifraud } from "@/lib/antifraud/access";
import {
  reviewQueueEvidenceSignals,
  reviewQueueSafeguard,
  reviewSignalLabel,
} from "@/lib/antifraud/signal-display";
import {
  ReviewSeverityBadge,
  ReviewStatusBadge,
} from "../_components/badges";
import { OpenCaseDialog } from "./_components/open-case-dialog";
import {
  ReviewCaseDialog,
  ReviewCaseNavigation,
} from "./_components/review-case-dialog";
import { ReviewCaseWorkspace } from "./_components/review-case-workspace";
import { ReviewSignalBadge } from "./_components/review-signal-badge";
import { StartReviewButton } from "./_components/start-review-button";

export const metadata = { title: "Account Review" };

/**
 * Antifraud → Account Review.
 *
 * The case queue. Filters and the selected review are URL-driven, so search,
 * paging, dialog state, and direct links stay shareable. Review details stream
 * into an accessible dialog without replacing the queue underneath it.
 *
 * Shell-first: the hero paints immediately, while the count-backed tabs and
 * active list stream behind one keyed Suspense boundary. Hidden tabs never
 * load their case data.
 */

const QUERY_TIMEOUT_MS = 10_000;

type SearchParams = {
  tab?: string;
  q?: string;
  cursor?: string;
  open?: string;
  targetUserId?: string;
  targetUsername?: string;
  reason?: string;
  monitorCaseId?: string;
  review?: string;
};

const REVIEW_TABS = ["reviews", "postponed", "auto-banned"] as const;
type ReviewTab = (typeof REVIEW_TABS)[number];

const REVIEW_TAB_LABELS: Record<ReviewTab, string> = {
  reviews: "Reviews",
  postponed: "Postponed",
  "auto-banned": "Auto banned",
};

export default async function ReviewQueuePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await requireAntifraudPageAccess();
  const params = await searchParams;

  const tab = (REVIEW_TABS as readonly string[]).includes(params.tab ?? "")
    ? (params.tab as ReviewTab)
    : "reviews";
  const search = params.q?.trim() || undefined;
  const cursor = params.cursor?.trim() || undefined;
  const directReviewId = z.string().uuid().safeParse(params.review).success
    ? params.review
    : undefined;
  const monitorCaseId = z.string().uuid().safeParse(params.monitorCaseId).success
    ? params.monitorCaseId
    : undefined;
  // Identity of the open dialog AS IT APPEARS IN THE URL — a direct review id,
  // or the monitor case id whose review is still being resolved. It keys the
  // dialog boundary; the review id itself may not be known yet.
  const selectedReviewId = directReviewId ?? monitorCaseId;
  // Started, NOT awaited. Resolving a monitor deep-link is a JSONB probe on
  // `antifraud_signals`; awaiting it here — above PageHero and outside every
  // Suspense boundary — held the whole shell hostage to a lookup that only
  // ever feeds the dialog. It now resolves inside the dialog's own boundary.
  // `getReviewIdForMonitorCase` wraps itself in `safeQueryOrNull`, so this
  // promise cannot reject.
  const monitorReviewId =
    !directReviewId && monitorCaseId
      ? getReviewIdForMonitorCase(monitorCaseId)
      : null;

  const filters: ReviewFilters = {
    // Automatic bans are already contained, so they stay out of both the
    // active and postponed work queues and live only in their own tab.
    status: "unresolved",
    postponed:
      tab === "postponed" ? true : tab === "reviews" ? false : undefined,
    autoBanned: tab === "auto-banned",
    severities: ["critical", "high"],
    severityFirst: true,
    search,
    limit: REVIEW_PAGE_SIZE,
  };

  const filterKey = `${tab}-${search ?? ""}-${cursor ?? "first"}`;
  const current = { tab, q: search, cursor };
  // Start the clicked case before the eager queue/count reads. The Vercel
  // ADMIN pool is intentionally one connection per instance, so call order is
  // also priority order; case content must win over background queue chrome.
  const directReviewDetail = directReviewId
    ? getReviewDetail(directReviewId)
    : undefined;
  const queueData = loadReviewQueueData(filters, cursor);
  const closeHref = buildHref({ review: undefined }, current);
  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity />
      </PageHero>

      <Suspense key={filterKey} fallback={<QueueSkeleton />}>
        <QueueList
          queueData={queueData}
          current={current}
          tab={tab}
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
      </Suspense>

      {selectedReviewId && (
        <Suspense
          key={selectedReviewId}
          fallback={
            <ReviewCaseDialog closeHref={closeHref}>
              <CaseDialogSkeleton />
            </ReviewCaseDialog>
          }
        >
          {directReviewId ? (
            <ReviewDialogFromQueue
              reviewId={directReviewId}
              detailData={directReviewDetail}
              queueData={queueData}
              current={current}
              viewerId={session.userId}
              canManage={canManageAntifraud(session)}
            />
          ) : (
            <ReviewDialogFromMonitorCase
              reviewId={monitorReviewId}
              queueData={queueData}
              current={current}
              viewerId={session.userId}
              canManage={canManageAntifraud(session)}
            />
          )}
        </Suspense>
      )}
    </div>
  );
}

/**
 * Deep-link arm: the monitor case id is resolved HERE instead of in the page
 * body, so the hero and the queue paint while the lookup runs. A link that
 * resolves to nothing renders nothing — exactly as before.
 */
async function ReviewDialogFromMonitorCase({
  reviewId,
  ...rest
}: {
  reviewId: Promise<string | null> | null;
  queueData: Promise<ReviewQueueData>;
  current: SearchParams;
  viewerId: string;
  canManage: boolean;
}) {
  const resolved = await reviewId;
  if (!resolved) return null;
  return <ReviewDialogFromQueue reviewId={resolved} {...rest} />;
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
  search,
  counts,
  openCaseProps,
}: {
  tab: ReviewTab;
  search?: string;
  counts: Record<ReviewTab, number>;
  openCaseProps: React.ComponentProps<typeof OpenCaseDialog>;
}) {
  const current: SearchParams = {
    tab,
    q: search,
  };

  return (
    <div className="rounded-xl border border-border/70 bg-card p-3 sm:p-4">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Queue
          </p>
          <nav
            aria-label="Review queue"
            className="inline-flex flex-wrap items-center gap-1 rounded-xl border border-border/60 bg-muted/30 p-1"
          >
            {REVIEW_TABS.map((value) => (
              <HostLink
                key={value}
                href={buildHref(
                  { tab: value, cursor: undefined, review: undefined },
                  current,
                )}
                aria-current={tab === value ? "page" : undefined}
                className={cn(
                  "inline-flex min-h-10 items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors",
                  tab === value
                    ? "border border-border/70 bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
                )}
              >
                {REVIEW_TAB_LABELS[value]}
                <span
                  className={cn(
                    "inline-flex min-w-6 items-center justify-center rounded-full px-1.5 py-0.5 text-xs tabular-nums",
                    tab === value
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  {counts[value].toLocaleString()}
                </span>
              </HostLink>
            ))}
          </nav>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 xl:w-auto xl:flex-nowrap">
          {/* GET form — no client JS, and the URL stays shareable. */}
          <form className="flex min-w-0 flex-1 gap-2">
            <input type="hidden" name="tab" value={tab} />
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

function loadReviewQueueData(filters: ReviewFilters, cursor?: string) {
  return safeQuery(
    async () => {
      // Without a search term the active tab count is the exact same total as
      // the page predicates. Reuse it instead of queueing a redundant COUNT
      // ahead of the selected case on the capacity-bounded ADMIN pool.
      const reuseTabCount = !filters.search;
      const [page, stats] = await Promise.all([
        listReviewPage(filters, cursor, { includeTotal: !reuseTabCount }),
        getAccountReviewTabCounts(),
      ]);
      if (reuseTabCount) {
        page.total = filters.autoBanned
          ? stats.autoBanned
          : filters.postponed
            ? stats.postponed
            : stats.reviews;
      }
      return { page, stats };
    },
    {
      page: { items: [], nextCursor: null, total: 0 },
      stats: {
        reviews: 0,
        postponed: 0,
        autoBanned: 0,
      },
    },
    "antifraud.review-queue",
    QUERY_TIMEOUT_MS,
  );
}

type ReviewQueueData = Awaited<ReturnType<typeof loadReviewQueueData>>;

async function QueueList({
  queueData,
  current,
  tab,
  search,
  openCaseProps,
}: {
  queueData: Promise<ReviewQueueData>;
  current: SearchParams;
  tab: ReviewTab;
  search?: string;
  openCaseProps: React.ComponentProps<typeof OpenCaseDialog>;
}) {
  const { data, error } = await queueData;
  const { page, stats } = data;
  const reviews = page.items;
  const counts: Record<ReviewTab, number> = {
    reviews: stats.reviews,
    postponed: stats.postponed,
    "auto-banned": stats.autoBanned,
  };

  return (
    <div className="space-y-4">
      <FilterBar
        tab={tab}
        search={search}
        counts={counts}
        openCaseProps={openCaseProps}
      />

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
              tab={tab}
            />
          ))}
        </ul>
      )}

      {!error && (current.cursor || page.nextCursor) && (
        <nav
          aria-label="Review queue pages"
          className="flex flex-wrap items-center justify-between gap-2"
        >
          {current.cursor ? (
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
    </div>
  );
}

function CaseRow({
  review,
  current,
  tab,
}: {
  review: ReviewListItem;
  current: SearchParams;
  tab: ReviewTab;
}) {
  const name = review.targetUsername ?? review.targetUserId;
  const safeguard = reviewQueueSafeguard(review.signals);
  const evidenceSignals = reviewQueueEvidenceSignals(review.signals);
  const shownSignals = evidenceSignals.slice(0, 4);
  const hiddenSignals = evidenceSignals.slice(4);
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
              <ReviewSeverityBadge severity={review.severity} />
              <ReviewStatusBadge status={review.status} />
              {review.assignee && (
                <span className="inline-flex items-center gap-1 rounded-sm border border-cyan-500/30 bg-cyan-500/5 px-1.5 py-0.5 text-[10px] font-semibold text-cyan-700 dark:text-cyan-300">
                  <UserCheck className="size-3" />
                  {review.assignee.label}
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
            {safeguard ? (
              <div
                className={cn(
                  "mt-2 flex max-w-2xl items-start gap-2.5 rounded-lg border px-3 py-2",
                  safeguard.tone === "critical"
                    ? "border-rose-500/25 bg-gradient-to-r from-rose-500/10 via-rose-500/5 to-transparent"
                    : "border-amber-500/25 bg-gradient-to-r from-amber-500/10 via-amber-500/5 to-transparent",
                )}
              >
                <ShieldCheck
                  className={cn(
                    "mt-0.5 size-4 shrink-0",
                    safeguard.tone === "critical"
                      ? "text-rose-600 dark:text-rose-400"
                      : "text-amber-600 dark:text-amber-400",
                  )}
                />
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-foreground">
                    {safeguard.title}
                  </p>
                  <p className="text-[11px] leading-4 text-muted-foreground">
                    {safeguard.detail}
                  </p>
                </div>
              </div>
            ) : (
              <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground">
                {review.reason}
              </p>
            )}
            {evidenceSignals.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {shownSignals.map((signal) => (
                  <ReviewSignalBadge key={signal} signal={signal} />
                ))}
                {hiddenSignals.length > 0 && (
                  <span
                    className="rounded-sm border border-border/60 bg-muted/30 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                    title={hiddenSignals.map(reviewSignalLabel).join(", ")}
                  >
                    +{hiddenSignals.length} more evidence signal
                    {hiddenSignals.length === 1 ? "" : "s"}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-3 lg:justify-end">
          <div className="text-left lg:text-right">
            {tab === "auto-banned" ? (
              <>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Automatically contained at
                </p>
                <p className="text-xs font-medium tabular-nums">
                  {review.automatedActionAt
                    ? formatDateTime(review.automatedActionAt)
                    : "Containment pending"}
                </p>
              </>
            ) : (
              <>
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
              </>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <HostLink
              href={`/users/${review.targetUserId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-9 min-w-28 items-center justify-center gap-1.5 rounded-md border border-border bg-background px-3 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Open profile of ${review.targetUsername ?? review.targetUserId} in a new tab`}
            >
              <UserRound className="size-3.5" />
              Profile
            </HostLink>
            {tab !== "postponed" && review.status === "open" ? (
              <StartReviewButton
                reviewId={review.id}
                href={buildHref({ review: review.id }, current)}
                label="Review"
                subject={review.targetUsername ?? review.targetUserId}
              />
            ) : (
              <HostLink
                href={buildHref({ review: review.id }, current)}
                scroll={false}
                prefetch={false}
                className="inline-flex h-9 min-w-28 items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`Open review for ${review.targetUsername ?? review.targetUserId}`}
              >
                <Eye className="size-4" />
                Open review
              </HostLink>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

function ReviewDialogFromQueue({
  reviewId,
  queueData,
  current,
  viewerId,
  canManage,
  detailData,
}: {
  reviewId: string;
  queueData: Promise<ReviewQueueData>;
  current: SearchParams;
  viewerId: string;
  canManage: boolean;
  detailData?: ReturnType<typeof getReviewDetail>;
}) {
  const closeHref = buildHref({ review: undefined }, current);

  // The queue can take its full timeout when counts or list enrichment are
  // slow. It is only needed for previous/next navigation, so never put it in
  // front of the case-detail request. Both reads now start independently and
  // the workspace can stream as soon as its own bounded queries finish.
  return (
    <ReviewCaseDialog
      key={reviewId}
      closeHref={closeHref}
      navigation={
        <Suspense fallback={<ReviewCaseNavigation />}>
          <ReviewQueueNavigation
            reviewId={reviewId}
            queueData={queueData}
            current={current}
          />
        </Suspense>
      }
    >
      <Suspense key={reviewId} fallback={<CaseDialogSkeleton />}>
        <ReviewCaseWorkspace
          reviewId={reviewId}
          detailData={detailData}
          viewerId={viewerId}
          canManage={canManage}
        />
      </Suspense>
    </ReviewCaseDialog>
  );
}

async function ReviewQueueNavigation({
  reviewId,
  queueData,
  current,
}: {
  reviewId: string;
  queueData: Promise<ReviewQueueData>;
  current: SearchParams;
}) {
  const { data } = await queueData;
  const reviews = data.page.items;
  const index = reviews.findIndex((review) => review.id === reviewId);
  const previous = index > 0 ? reviews[index - 1] : undefined;
  const next = index >= 0 ? reviews[index + 1] : undefined;

  return (
    <ReviewCaseNavigation
      previousHref={
        previous ? buildHref({ review: previous.id }, current) : undefined
      }
      nextHref={next ? buildHref({ review: next.id }, current) : undefined}
    />
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
      <Skeleton className="h-24 w-full rounded-xl" />
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
