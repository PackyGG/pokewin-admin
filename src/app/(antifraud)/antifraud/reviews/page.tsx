import { Suspense } from "react";
import { HostLink } from "@/components/host-link";
import {
  ArrowUp,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Eye,
  FolderOpen,
  Search,
  ShieldAlert,
  TriangleAlert,
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
  getReviewStats,
  listReviewPage,
  REVIEW_PAGE_SIZE,
  REVIEW_STATUSES,
  REVIEW_STATUS_LABELS,
  isReviewStatus,
  type ReviewFilters,
  type ReviewListItem,
} from "@/lib/antifraud/reviews";
import { listKycRequiredUserIds } from "@/lib/antifraud/kyc";
import { ReviewStatusBadge } from "../_components/badges";
import { OpenCaseDialog } from "./_components/open-case-dialog";
import { QuickReviewActions } from "./_components/quick-review-actions";
import { ReviewSignalBadge } from "./_components/review-signal-badge";

export const metadata = { title: "Account Review" };

/**
 * Antifraud → Account Review.
 *
 * The case queue. Filters are plain links driven by search params (no client
 * state, no extra JS). Status and chronological ordering use the queue indexes.
 * Text search is prefix-only and its list + COUNT predicates are covered by the
 * ADMIN pg_trgm indexes.
 *
 * Shell-first: the hero + filter bar paint immediately, the KPI strip and the
 * list stream behind their own Suspense boundary keyed on the active filter so
 * switching filters shows a skeleton instead of a stale list.
 */

const QUERY_TIMEOUT_MS = 10_000;

type SearchParams = {
  status?: string;
  q?: string;
  cursor?: string;
  open?: string;
  targetUserId?: string;
  targetUsername?: string;
  reason?: string;
  monitorCaseId?: string;
};

export default async function ReviewQueuePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requireAntifraudPageAccess();
  const params = await searchParams;

  const status =
    params.status === "all"
      ? "all"
      : params.status && isReviewStatus(params.status)
        ? params.status
        : "unresolved";
  const search = params.q?.trim() || undefined;
  const cursor = params.cursor?.trim() || undefined;

  const filters: ReviewFilters = {
    status,
    search,
    limit: REVIEW_PAGE_SIZE,
  };

  const filterKey = `${status}-${search ?? ""}-${cursor ?? "first"}`;
  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity />
      </PageHero>

      <FilterBar
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
          current={{ status, q: search }}
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

function FilterChip({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Button
      size="sm"
      variant={active ? "default" : "outline"}
      render={<HostLink href={href} />}
    >
      {children}
    </Button>
  );
}

function FilterBar({
  status,
  search,
  openCaseProps,
}: {
  status: string;
  search?: string;
  openCaseProps: React.ComponentProps<typeof OpenCaseDialog>;
}) {
  const current: SearchParams = {
    status,
    q: search,
  };

  return (
    <div className="rounded-xl border border-border/70 bg-card p-3">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex flex-wrap items-center gap-1.5">
          <FilterChip
            href={buildHref({ status: "unresolved", cursor: undefined }, current)}
            active={status === "unresolved"}
          >
            Needs work
          </FilterChip>
          <span className="mx-1 hidden h-8 w-px bg-border sm:block" />
          {REVIEW_STATUSES.map((value) => (
            <FilterChip
              key={value}
              href={buildHref({ status: value, cursor: undefined }, current)}
              active={status === value}
            >
              {REVIEW_STATUS_LABELS[value]}
            </FilterChip>
          ))}
          <FilterChip
            href={buildHref({ status: "all", cursor: undefined }, current)}
            active={status === "all"}
          >
            All
          </FilterChip>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 xl:w-auto xl:flex-nowrap">
          {/* GET form — no client JS, and the URL stays shareable. */}
          <form className="flex min-w-0 flex-1 gap-2">
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
}: {
  filters: ReviewFilters;
  cursor?: string;
  current: SearchParams;
}) {
  const { data, error } = await safeQuery(
    async () => {
      // KYC-required accounts belong only in the dedicated KYC workspace.
      // Resolve that scope before both ADMIN reads so pagination, totals, and
      // queue KPIs all describe the same visible set.
      const excludedTargetUserIds = await listKycRequiredUserIds();
      const scopedFilters = { ...filters, excludedTargetUserIds };
      const [page, stats] = await Promise.all([
        listReviewPage(scopedFilters, cursor),
        getReviewStats(undefined, excludedTargetUserIds),
      ]);
      return { page, stats };
    },
    {
      page: { items: [], nextCursor: null, total: 0 },
      stats: {
        open: 0,
        inReview: 0,
        escalated: 0,
        resolvedToday: 0,
        flaggedTotal: 0,
        mineOpen: 0,
      },
    },
    "antifraud.review-queue",
    QUERY_TIMEOUT_MS,
  );
  const { page, stats } = data;
  const reviews = page.items;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile
          icon={FolderOpen}
          accent="cyan"
          label="Open"
          value={stats.open.toLocaleString()}
          sub="untouched cases"
        />
        <KpiTile
          icon={Clock3}
          accent="blue"
          label="In review"
          value={stats.inReview.toLocaleString()}
          sub="being worked on"
        />
        <KpiTile
          icon={TriangleAlert}
          accent={stats.escalated > 0 ? "amber" : "emerald"}
          label="Escalated"
          value={stats.escalated.toLocaleString()}
          sub="need a senior look"
        />
        <KpiTile
          icon={CheckCircle2}
          accent="emerald"
          label="Resolved today"
          value={stats.resolvedToday.toLocaleString()}
          sub="cleared or flagged"
        />
      </div>

      <SectionHeading
        icon={ShieldAlert}
        title={
          <>
            Cases
            <span className="text-xs font-normal text-muted-foreground">
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
        <div className="flex flex-col items-center gap-1.5 rounded-xl border border-dashed border-border/70 bg-card/40 px-4 py-12 text-center">
          <CheckCircle2 className="size-5 text-muted-foreground" />
          <span className="text-sm font-semibold">Nothing here</span>
          <span className="max-w-sm text-xs text-muted-foreground">
            No cases match this filter. Cases arrive automatically from the
            fraud backend, or you can open one with the button above.
          </span>
        </div>
      ) : (
        <ul className="space-y-3">
          {reviews.map((review) => (
            <CaseRow key={review.id} review={review} />
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
    </div>
  );
}

function CaseRow({ review }: { review: ReviewListItem }) {
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
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
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
            <HostLink
              href={`/antifraud/reviews/${review.id}`}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Review ${review.targetUsername ?? review.targetUserId}`}
            >
              <Eye className="size-3.5" />
              Review
            </HostLink>
            <QuickReviewActions
              reviewId={review.id}
              targetUserId={review.targetUserId}
              targetUsername={review.targetUsername}
              status={review.status}
              compact
            />
          </div>
        </div>
      </div>
    </li>
  );
}

function QueueSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
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
