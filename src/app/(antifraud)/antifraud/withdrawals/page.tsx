import { Suspense } from "react";
import { z } from "zod";
import {
  AlertTriangle,
  ArrowRight,
  Search,
  ShieldAlert,
  ShieldCheck,
  UserRound,
  WalletCards,
} from "lucide-react";

import { HostLink } from "@/components/host-link";
import { KpiTile, PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  listWithdrawalAssessments,
  getWithdrawalAssessment,
  type WithdrawalAssessment,
  type WithdrawalReviewStatus,
  type WithdrawalVerdict,
} from "@/lib/antifraud/withdrawals-api";
import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";
import { cn } from "@/lib/utils";
import { formatCurrency, formatDateTime } from "@/lib/utils/format";
import {
  EmptyState,
  Fact,
  FilterButton,
  FilterGroup,
  ListPageSkeleton,
  ListPagination,
  mergeFilterSelection,
  parsePageParam,
  verdictStyle,
} from "../_components/list-page";
import { QueueReviewDrawer } from "../_components/review-drawer";
import { WithdrawalReviewDialog } from "./review-dialog";

export const metadata = { title: "Withdrawals · Antifraud" };

const STATUSES = [
  "pending",
  "processing",
  "shipped",
  "completed",
  "failed",
  "cancelled",
] as const;
const VERDICTS = ["good", "review", "bad"] as const;
const REVIEW_STATUSES = [
  "unreviewed",
  "in_review",
  "cleared",
  "block_recommended",
] as const;

type FilterState = {
  page: number;
  status?: string;
  verdict?: WithdrawalVerdict;
  reviewStatus?: WithdrawalReviewStatus;
  search: string;
};

export default async function WithdrawalsPage({
  searchParams,
}: {
  searchParams: Promise<{
    page?: string;
    status?: string;
    verdict?: string;
    reviewStatus?: string;
    search?: string;
    review?: string;
  }>;
}) {
  await requireAntifraudPageAccess();
  const params = await searchParams;
  const state: FilterState = {
    page: parsePageParam(params.page),
    status: STATUSES.includes(params.status as (typeof STATUSES)[number])
      ? params.status
      : undefined,
    verdict: VERDICTS.includes(params.verdict as WithdrawalVerdict)
      ? (params.verdict as WithdrawalVerdict)
      : undefined,
    reviewStatus: REVIEW_STATUSES.includes(
      params.reviewStatus as (typeof REVIEW_STATUSES)[number],
    )
      ? (params.reviewStatus as WithdrawalReviewStatus)
      : undefined,
    search: params.search?.trim().slice(0, 100) ?? "",
  };
  const selectedReviewId = z.string().uuid().safeParse(params.review).success
    ? params.review
    : undefined;

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity />
      </PageHero>

      <Filters state={state} />

      <Suspense
        key={`${state.page}-${state.status}-${state.verdict}-${state.reviewStatus}-${state.search}`}
        fallback={<ListPageSkeleton />}
      >
        <WithdrawalContent
          state={state}
          selectedReviewId={selectedReviewId}
        />
      </Suspense>
    </div>
  );
}

function Filters({ state }: { state: FilterState }) {
  const filterHref = (selection: {
    status?: string | null;
    verdict?: WithdrawalVerdict | null;
    reviewStatus?: WithdrawalReviewStatus | null;
  }) => withdrawalHref(mergeFilterSelection(state, selection));
  return (
    <div className="rounded-xl border border-border/70 bg-card p-3">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
        <div className="flex flex-wrap items-start gap-x-5 gap-y-3">
          <FilterGroup label="Risk">
            <FilterButton label="All" active={!state.verdict} href={filterHref({ verdict: null })} />
            <FilterButton label="Good" active={state.verdict === "good"} href={filterHref({ verdict: "good" })} />
            <FilterButton label="Review" active={state.verdict === "review"} href={filterHref({ verdict: "review" })} />
            <FilterButton label="Bad" active={state.verdict === "bad"} href={filterHref({ verdict: "bad" })} />
          </FilterGroup>
          <FilterGroup label="Workflow">
            <FilterButton
              label="All"
              active={!state.reviewStatus}
              href={filterHref({ reviewStatus: null })}
            />
            <FilterButton
              label="Pending"
              active={state.reviewStatus === "unreviewed"}
              href={filterHref({ reviewStatus: "unreviewed" })}
            />
            <FilterButton
              label="In review"
              active={state.reviewStatus === "in_review"}
              href={filterHref({ reviewStatus: "in_review" })}
            />
          </FilterGroup>
          <FilterGroup label="Payout status">
            <FilterButton label="Any" active={!state.status} href={filterHref({ status: null })} />
            <FilterButton label="Pending" active={state.status === "pending"} href={filterHref({ status: "pending" })} />
            <FilterButton label="Processing" active={state.status === "processing"} href={filterHref({ status: "processing" })} />
            <FilterButton label="Completed" active={state.status === "completed"} href={filterHref({ status: "completed" })} />
          </FilterGroup>
        </div>
        <form className="flex w-full gap-2 xl:w-auto" action="/antifraud/withdrawals">
          {state.status && <input type="hidden" name="status" value={state.status} />}
          {state.verdict && <input type="hidden" name="verdict" value={state.verdict} />}
          {state.reviewStatus && (
            <input type="hidden" name="reviewStatus" value={state.reviewStatus} />
          )}
          <Input
            name="search"
            defaultValue={state.search}
            placeholder="User, email, or ID"
            maxLength={100}
            aria-label="Search withdrawals"
            className="min-w-0 xl:w-64"
          />
          <Button type="submit" variant="outline" aria-label="Search">
            <Search className="size-4" />
          </Button>
        </form>
      </div>
    </div>
  );
}

async function WithdrawalContent({
  state,
  selectedReviewId,
}: {
  state: FilterState;
  selectedReviewId?: string;
}) {
  const result = await listWithdrawalAssessments({
    page: state.page,
    status: state.status,
    verdict: state.verdict,
    reviewStatus: state.reviewStatus,
    search: state.search || undefined,
  });
  if (!result.configured) {
    return <EmptyState text="The Antifraud monitor service is not configured." />;
  }
  if (result.error) {
    return <EmptyState text="Withdrawal assessments could not be loaded." />;
  }
  if (result.data.length === 0) {
    return <EmptyState text="No withdrawals match these filters yet." />;
  }
  return (
    <div className="space-y-4">
      {result.summary && <SummaryCards summary={result.summary} />}
      <div className="space-y-3">
        {result.data.map((withdrawal) => (
          <WithdrawalRow
            key={withdrawal.withdrawal_id}
            withdrawal={withdrawal}
            reviewHref={`${withdrawalHref(state)}${withdrawalHref(state).includes("?") ? "&" : "?"}review=${encodeURIComponent(withdrawal.withdrawal_id)}`}
          />
        ))}
      </div>
      {result.pagination && (
        <ListPagination
          page={result.pagination.page}
          pages={result.pagination.pages}
          total={result.pagination.total}
          unitLabel="tracked withdrawals"
          previousHref={
            state.page > 1
              ? withdrawalHref({ ...state, page: state.page - 1 })
              : undefined
          }
          nextHref={
            state.page < result.pagination.pages
              ? withdrawalHref({ ...state, page: state.page + 1 })
              : undefined
          }
        />
      )}
      {selectedReviewId && (
        <Suspense
          fallback={
            <QueueReviewDrawer
              title="Withdrawal review"
              description="Loading the source-of-funds trace without leaving the queue."
              closeHref={withdrawalHref(state)}
            >
              <Skeleton className="h-[38rem] rounded-xl" />
            </QueueReviewDrawer>
          }
        >
          <WithdrawalReviewOverlay
            withdrawalId={selectedReviewId}
            closeHref={withdrawalHref(state)}
          />
        </Suspense>
      )}
    </div>
  );
}

async function WithdrawalReviewOverlay({
  withdrawalId,
  closeHref,
}: {
  withdrawalId: string;
  closeHref: string;
}) {
  const result = await getWithdrawalAssessment(withdrawalId);
  if (!result.configured || result.error || result.notFound || !result.data) {
    return (
      <QueueReviewDrawer
        title="Withdrawal review"
        description="The selected assessment could not be loaded."
        closeHref={closeHref}
      >
        <EmptyState text="Close this review and try again. The queue and filters are unchanged." />
      </QueueReviewDrawer>
    );
  }
  return (
    <WithdrawalReviewDialog
      withdrawal={result.data.assessment}
      closeHref={closeHref}
    />
  );
}

function SummaryCards({
  summary,
}: {
  summary: {
    total: number;
    good: number;
    review: number;
    bad: number;
    unreviewed: number;
    in_review: number;
    block_recommended: number;
    amount_usd: number;
  };
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <KpiTile
        icon={WalletCards}
        accent="cyan"
        label="Analyzed"
        value={summary.total.toLocaleString()}
        sub={`${formatCurrency(summary.amount_usd)} requested`}
      />
      <KpiTile
        icon={ShieldCheck}
        accent="emerald"
        label="No signal"
        value={summary.good.toLocaleString()}
        sub={`${summary.unreviewed.toLocaleString()} awaiting analyst`}
      />
      <KpiTile
        icon={AlertTriangle}
        accent="amber"
        label="Needs review"
        value={summary.review.toLocaleString()}
        sub={`${summary.in_review.toLocaleString()} in progress`}
      />
      <KpiTile
        icon={ShieldAlert}
        accent="rose"
        label="High risk"
        value={summary.bad.toLocaleString()}
        sub={`${summary.block_recommended.toLocaleString()} blocks advised`}
      />
    </div>
  );
}

function WithdrawalRow({
  withdrawal,
  reviewHref,
}: {
  withdrawal: WithdrawalAssessment;
  reviewHref: string;
}) {
  const name = withdrawal.username ?? withdrawal.user_id;
  const verdict = verdictStyle(withdrawal.verdict);
  const VerdictIcon = verdict.icon;
  const flow = withdrawal.flow;
  const flagged = withdrawal.flow_checks.filter(
    (check) => check.status === "watch" || check.status === "alert",
  );
  const scored = withdrawal.flow_checks.filter(
    (check) => check.status !== "not_applicable",
  );
  const traceableSources = withdrawal.source_breakdown.filter(
    (source) => source.traceable,
  ).length;
  return (
    <article className="rounded-xl border border-border/70 bg-card p-4 shadow-sm">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar className="size-10">
            {withdrawal.avatar_url && <AvatarImage src={withdrawal.avatar_url} alt="" />}
            <AvatarFallback>{name.slice(0, 2).toUpperCase()}</AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <p className="truncate font-semibold">{name}</p>
              <HostLink
                href={`/users/${withdrawal.user_id}`}
                aria-label="Open user profile"
                title="User profile"
                className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <UserRound className="size-3.5" />
              </HostLink>
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {withdrawal.email ?? withdrawal.user_id}
            </p>
          </div>
          <Badge variant="outline" className="shrink-0 capitalize">
            {withdrawal.status}
          </Badge>
          <Badge variant="secondary" className="shrink-0 capitalize">
            {withdrawal.method}
          </Badge>
        </div>
        <div className="flex flex-wrap items-center gap-3 lg:justify-end">
          <div className="min-w-28 text-right">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Withdrawal
            </p>
            <p className="text-lg font-semibold tabular-nums">
              {formatCurrency(withdrawal.amount_usd)}
            </p>
            <p className="text-[10px] tabular-nums text-muted-foreground">
              {formatDateTime(withdrawal.requested_at)}
            </p>
          </div>
          <div className={cn("flex min-w-32 items-center gap-2 rounded-lg border px-3 py-2", verdict.box)}>
            <VerdictIcon className={cn("size-5", verdict.text)} />
            <span>
              <span className={cn("block text-sm font-semibold capitalize", verdict.text)}>
                {withdrawal.verdict}
              </span>
              <span className="block text-[10px] text-muted-foreground">
                {withdrawal.risk_score}/100 risk
              </span>
            </span>
          </div>
          {withdrawal.flow_checks.length > 0 ? (
            <Button size="sm" render={<HostLink href={reviewHref} scroll={false} />}>
              Open review
              <ArrowRight className="size-3.5" />
            </Button>
          ) : (
            <Button size="sm" disabled>
              Assessment pending
            </Button>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 border-t border-border/60 pt-3 text-xs">
        {withdrawal.flow_checks.length > 0 && (
          <Fact
            label="Review flow"
            value={`${scored.length - flagged.length}/${scored.length} pass`}
            alert={flagged.length > 0}
          />
        )}
        <Fact
          label="90-day account activity"
          value={`${formatCurrency(flow.depositsUsd)} deposits`}
        />
        <Fact label="Gross wagered" value={formatCurrency(flow.wageredUsd)} />
        <Fact
          label="Rewards / credits"
          value={formatCurrency(flow.rewardsUsd)}
        />
        <Fact
          label="Sources"
          value={
            withdrawal.source_breakdown.length
              ? `${traceableSources}/${withdrawal.source_breakdown.length} traceable`
              : withdrawal.method === "balance"
                ? "Balance request"
                : "None attached"
          }
          alert={
            withdrawal.source_breakdown.length > 0 &&
            traceableSources < withdrawal.source_breakdown.length
          }
        />
        <Badge variant="secondary" className="ml-auto shrink-0 capitalize">
          {withdrawal.review_status === "unreviewed"
            ? "Pending"
            : withdrawal.review_status.replaceAll("_", " ")}
        </Badge>
      </div>
      <p className="mt-2 line-clamp-1 text-xs text-muted-foreground">
        {withdrawal.summary}
      </p>
    </article>
  );
}

function withdrawalHref(state: FilterState): string {
  const params = new URLSearchParams();
  if (state.page > 1) params.set("page", String(state.page));
  if (state.status) params.set("status", state.status);
  if (state.verdict) params.set("verdict", state.verdict);
  if (state.reviewStatus) params.set("reviewStatus", state.reviewStatus);
  if (state.search) params.set("search", state.search);
  const query = params.toString();
  return `/antifraud/withdrawals${query ? `?${query}` : ""}`;
}
