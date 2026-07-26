import { Suspense } from "react";
import { HostLink } from "@/components/host-link";
import { ArrowUp, CheckCircle2, ChevronRight, ShieldAlert } from "lucide-react";

import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";
import { safeQuery } from "@/lib/errors/safe-query";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatDateTime, formatRelative } from "@/lib/utils/format";
import {
  listReviewPage,
  REVIEW_PAGE_SIZE,
  REVIEW_STATUSES,
  REVIEW_STATUS_LABELS,
  isReviewStatus,
  type ReviewFilters,
} from "@/lib/antifraud/reviews";
import { ReviewStatusBadge } from "../_components/badges";
import { OpenCaseDialog } from "./_components/open-case-dialog";

export const metadata = { title: "Account Review" };

/**
 * Antifraud → Account Review.
 *
 * The case queue. Filters are plain links driven by search params (no client
 * state, no extra JS). Status, assignment and chronological ordering use the
 * queue indexes. Text search is prefix-only and its list + COUNT predicates
 * are covered by the ADMIN pg_trgm indexes.
 *
 * Shell-first: the hero + filter bar paint immediately, the list streams behind
 * its own Suspense boundary keyed on the active filter so switching filters
 * shows a skeleton instead of a stale list.
 */

const QUERY_TIMEOUT_MS = 10_000;

type SearchParams = {
  status?: string;
  mine?: string;
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
  const session = await requireAntifraudPageAccess();
  const params = await searchParams;

  const status =
    params.status === "all"
      ? "all"
      : params.status && isReviewStatus(params.status)
        ? params.status
        : "unresolved";
  const mine = params.mine === "1";
  const search = params.q?.trim() || undefined;
  const cursor = params.cursor?.trim() || undefined;

  const filters: ReviewFilters = {
    status,
    assignedTo: mine ? session.userId : undefined,
    search,
    limit: REVIEW_PAGE_SIZE,
  };

  const filterKey = `${status}-${mine ? "mine" : "all"}-${search ?? ""}-${cursor ?? "first"}`;
  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={ShieldAlert}
          accent="cyan"
          title="Account Review"
          subtitle="Cases opened by the fraud backend or by hand"
          action={
            <OpenCaseDialog
              prefill={{
                targetUserId: params.targetUserId,
                targetUsername: params.targetUsername,
                reason: params.reason,
                monitorCaseId: params.monitorCaseId,
              }}
              autoOpen={params.open === "1"}
            />
          }
        />
      </PageHero>

      <FilterBar
        status={status}
        mine={mine}
        search={search}
      />

      <Suspense key={filterKey} fallback={<QueueSkeleton />}>
        <QueueList
          filters={filters}
          cursor={cursor}
          current={{ status, mine: mine ? "1" : undefined, q: search }}
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
    <HostLink
      href={href}
      className={cn(
        "rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
        active
          ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-600 dark:text-cyan-300"
          : "border-border/60 bg-muted/40 text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </HostLink>
  );
}

function FilterBar({
  status,
  mine,
  search,
}: {
  status: string;
  mine: boolean;
  search?: string;
}) {
  const current: SearchParams = {
    status,
    mine: mine ? "1" : undefined,
    q: search,
  };

  return (
    <div className="space-y-2.5 rounded-xl border border-border/60 bg-card p-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Status
        </span>
        <FilterChip
          href={buildHref({ status: "unresolved", cursor: undefined }, current)}
          active={status === "unresolved"}
        >
          Needs work
        </FilterChip>
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

      <div className="flex flex-wrap items-center gap-1.5">
        <FilterChip
          href={buildHref({
            mine: mine ? undefined : "1",
            cursor: undefined,
          }, current)}
          active={mine}
        >
          Assigned to me
        </FilterChip>
      </div>

      {/* GET form — no client JS, and the URL stays shareable. */}
      <form className="flex flex-wrap gap-2">
        {status && <input type="hidden" name="status" value={status} />}
        {mine && <input type="hidden" name="mine" value="1" />}
        <input
          type="search"
          name="q"
          defaultValue={search ?? ""}
          placeholder="Search username, player id or reason…"
          className="h-8 min-w-0 flex-1 rounded-md border border-border/60 bg-background px-2.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <button
          type="submit"
          className="h-8 shrink-0 rounded-md border border-border/60 bg-muted/40 px-3 text-xs font-medium transition-colors hover:bg-muted"
        >
          Search
        </button>
      </form>
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
  const { data: page, error } = await safeQuery(
    () => listReviewPage(filters, cursor),
    { items: [], nextCursor: null, total: 0 },
    "antifraud.review-queue",
    QUERY_TIMEOUT_MS,
  );
  const reviews = page.items;

  return (
    <div className="space-y-4">
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
        <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60 bg-card">
          {reviews.map((review) => (
            <li key={review.id}>
              <HostLink
                href={`/antifraud/reviews/${review.id}`}
                className="flex flex-col gap-2 px-3 py-3 outline-none transition-colors hover:bg-accent/50 focus-visible:bg-accent/50 sm:flex-row sm:items-center sm:gap-4 sm:px-4"
              >
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-sm font-semibold">
                      {review.targetUsername ?? review.targetUserId}
                    </span>
                    <ReviewStatusBadge status={review.status} />
                    {review.riskScore != null && (
                      <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                        risk {review.riskScore}
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 line-clamp-1 block text-xs text-muted-foreground">
                    {review.reason}
                  </span>
                  {review.signals.length > 0 && (
                    <span className="mt-1 flex flex-wrap gap-1">
                      {review.signals.slice(0, 4).map((signal) => (
                        <span
                          key={signal}
                          className="rounded-sm border border-border/60 px-1.5 py-0.5 text-[10px] text-muted-foreground"
                        >
                          {signal}
                        </span>
                      ))}
                    </span>
                  )}
                </span>

                <span className="flex shrink-0 items-center gap-3 text-[11px] text-muted-foreground">
                  <span className="min-w-0 truncate">
                    {review.assignee
                      ? `→ ${review.assignee.label}`
                      : "unassigned"}
                  </span>
                  <span
                    className="shrink-0 whitespace-nowrap"
                    title={formatDateTime(review.createdAt)}
                  >
                    {formatRelative(review.createdAt)}
                  </span>
                </span>
              </HostLink>
            </li>
          ))}
        </ul>
      )}

      {!error && (cursor || page.nextCursor) && (
        <nav
          aria-label="Review queue pages"
          className="flex flex-wrap items-center justify-between gap-2"
        >
          {cursor ? (
            <HostLink
              href={buildHref({ cursor: undefined }, current)}
              className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowUp className="size-3.5" />
              Back to newest
            </HostLink>
          ) : (
            <span />
          )}
          {page.nextCursor && (
            <HostLink
              href={buildHref({ cursor: page.nextCursor }, current)}
              className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              Older cases
              <ChevronRight className="size-3.5" />
            </HostLink>
          )}
        </nav>
      )}
    </div>
  );
}

function QueueSkeleton() {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2.5">
        <Skeleton className="size-7 rounded-lg" />
        <Skeleton className="h-4 w-32" />
      </div>
      <div className="overflow-hidden rounded-xl border border-border/60">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full rounded-none" />
        ))}
      </div>
    </div>
  );
}
