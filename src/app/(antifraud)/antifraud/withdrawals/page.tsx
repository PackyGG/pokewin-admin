import { Suspense } from "react";
import {
  AlertTriangle,
  ArrowRight,
  ArrowUpFromLine,
  ChevronLeft,
  ChevronRight,
  Search,
  ShieldAlert,
  ShieldCheck,
  UserRound,
  UserRoundSearch,
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
  type WithdrawalAssessment,
  type WithdrawalReviewStatus,
  type WithdrawalVerdict,
} from "@/lib/antifraud/withdrawals-api";
import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils/format";

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
  "escalated",
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
  }>;
}) {
  await requireAntifraudPageAccess();
  const params = await searchParams;
  const rawPage = Number(params.page ?? "1");
  const state: FilterState = {
    page: Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1,
    status: STATUSES.includes(params.status as (typeof STATUSES)[number])
      ? params.status
      : undefined,
    verdict: VERDICTS.includes(params.verdict as WithdrawalVerdict)
      ? (params.verdict as WithdrawalVerdict)
      : undefined,
    reviewStatus: REVIEW_STATUSES.includes(
      params.reviewStatus as WithdrawalReviewStatus,
    )
      ? (params.reviewStatus as WithdrawalReviewStatus)
      : undefined,
    search: params.search?.trim().slice(0, 100) ?? "",
  };

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={ArrowUpFromLine}
          accent="cyan"
          title="Withdrawal security"
          subtitle="Run every payout through funding, behavior, account, and destination checks"
        />
      </PageHero>

      <Filters state={state} />

      <Suspense
        key={`${state.page}-${state.status}-${state.verdict}-${state.reviewStatus}-${state.search}`}
        fallback={<WithdrawalListSkeleton />}
      >
        <WithdrawalContent state={state} />
      </Suspense>
    </div>
  );
}

function Filters({ state }: { state: FilterState }) {
  return (
    <div className="rounded-xl border border-border/70 bg-card p-3">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
        <div className="flex flex-wrap items-start gap-x-5 gap-y-3">
          <FilterGroup label="Risk">
            <FilterButton label="All" active={!state.verdict} state={state} verdict={null} />
            <FilterButton label="Good" active={state.verdict === "good"} state={state} verdict="good" />
            <FilterButton label="Review" active={state.verdict === "review"} state={state} verdict="review" />
            <FilterButton label="Bad" active={state.verdict === "bad"} state={state} verdict="bad" />
          </FilterGroup>
          <FilterGroup label="Workflow">
            <FilterButton
              label="All"
              active={!state.reviewStatus}
              state={state}
              reviewStatus={null}
            />
            <FilterButton
              label="Unreviewed"
              active={state.reviewStatus === "unreviewed"}
              state={state}
              reviewStatus="unreviewed"
            />
            <FilterButton
              label="In review"
              active={state.reviewStatus === "in_review"}
              state={state}
              reviewStatus="in_review"
            />
            <FilterButton
              label="Escalated"
              active={state.reviewStatus === "escalated"}
              state={state}
              reviewStatus="escalated"
            />
          </FilterGroup>
          <FilterGroup label="Payout status">
            <FilterButton label="Any" active={!state.status} state={state} status={null} />
            <FilterButton label="Pending" active={state.status === "pending"} state={state} status="pending" />
            <FilterButton label="Processing" active={state.status === "processing"} state={state} status="processing" />
            <FilterButton label="Completed" active={state.status === "completed"} state={state} status="completed" />
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

function FilterGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <div className="inline-flex flex-wrap items-center gap-0.5 rounded-lg border border-border/60 bg-muted/30 p-0.5">
        {children}
      </div>
    </div>
  );
}

function FilterButton({
  label,
  active,
  state,
  status,
  verdict,
  reviewStatus,
}: {
  label: string;
  active: boolean;
  state: FilterState;
  status?: string | null;
  verdict?: WithdrawalVerdict | null;
  reviewStatus?: WithdrawalReviewStatus | null;
}) {
  const next = {
    ...state,
    page: 1,
    status: status === null ? undefined : status ?? state.status,
    verdict: verdict === null ? undefined : verdict ?? state.verdict,
    reviewStatus:
      reviewStatus === null ? undefined : reviewStatus ?? state.reviewStatus,
  };
  return (
    <HostLink
      href={withdrawalHref(next)}
      aria-current={active ? "true" : undefined}
      className={cn(
        "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
        active
          ? "border border-border/70 bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </HostLink>
  );
}

async function WithdrawalContent({ state }: { state: FilterState }) {
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
          <WithdrawalRow key={withdrawal.withdrawal_id} withdrawal={withdrawal} />
        ))}
      </div>
      {result.pagination && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            Page {result.pagination.page} of {result.pagination.pages} ·{" "}
            {result.pagination.total} tracked withdrawals
          </span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={state.page <= 1}
              render={
                state.page > 1 ? (
                  <HostLink href={withdrawalHref({ ...state, page: state.page - 1 })} />
                ) : undefined
              }
            >
              <ChevronLeft className="size-3.5" />
              Previous
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={state.page >= result.pagination.pages}
              render={
                state.page < result.pagination.pages ? (
                  <HostLink href={withdrawalHref({ ...state, page: state.page + 1 })} />
                ) : undefined
              }
            >
              Next
              <ChevronRight className="size-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
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
    escalated: number;
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
        sub={`${summary.unreviewed.toLocaleString()} unreviewed`}
      />
      <KpiTile
        icon={AlertTriangle}
        accent="amber"
        label="Needs review"
        value={summary.review.toLocaleString()}
        sub={`${summary.escalated.toLocaleString()} escalated`}
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

function WithdrawalRow({ withdrawal }: { withdrawal: WithdrawalAssessment }) {
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
              {formatDate(withdrawal.requested_at)}
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
            <Button
              size="sm"
              render={
                <HostLink
                  href={`/antifraud/withdrawals/${withdrawal.withdrawal_id}`}
                />
              }
            >
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
          {withdrawal.review_status.replaceAll("_", " ")}
        </Badge>
      </div>
      <p className="mt-2 line-clamp-1 text-xs text-muted-foreground">
        {withdrawal.summary}
      </p>
    </article>
  );
}

function Fact({
  label,
  value,
  alert = false,
}: {
  label: string;
  value: string;
  alert?: boolean;
}) {
  return (
    <span className="inline-flex max-w-72 items-baseline gap-1.5">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span
        className={cn(
          "truncate font-medium tabular-nums",
          alert && "text-amber-600 dark:text-amber-400",
        )}
      >
        {value}
      </span>
    </span>
  );
}

function verdictStyle(verdict: WithdrawalVerdict) {
  if (verdict === "good") {
    return {
      icon: ShieldCheck,
      text: "text-emerald-600 dark:text-emerald-400",
      box: "border-emerald-500/25 bg-emerald-500/5",
    };
  }
  if (verdict === "bad") {
    return {
      icon: ShieldAlert,
      text: "text-rose-600 dark:text-rose-400",
      box: "border-rose-500/25 bg-rose-500/5",
    };
  }
  return {
    icon: AlertTriangle,
    text: "text-amber-600 dark:text-amber-400",
    box: "border-amber-500/25 bg-amber-500/5",
  };
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

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="rounded-xl border border-dashed border-border/70 bg-card/40 px-4 py-14 text-center">
      <UserRoundSearch className="mx-auto mb-3 size-6 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">{text}</p>
    </div>
  );
}

function WithdrawalListSkeleton() {
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-24 rounded-xl" />
        ))}
      </div>
      {Array.from({ length: 4 }).map((_, index) => (
        <Skeleton key={index} className="h-36 rounded-xl" />
      ))}
    </div>
  );
}
