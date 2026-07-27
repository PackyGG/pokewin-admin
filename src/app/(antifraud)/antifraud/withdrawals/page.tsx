import { Suspense } from "react";
import {
  AlertTriangle,
  ArrowRight,
  ArrowUpFromLine,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  Gift,
  Search,
  ShieldAlert,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
  UserRoundSearch,
  WalletCards,
} from "lucide-react";

import { HostLink } from "@/components/host-link";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  listWithdrawalAssessments,
  type WithdrawalAssessment,
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

type FilterState = {
  page: number;
  status?: string;
  verdict?: WithdrawalVerdict;
  search: string;
};

export default async function WithdrawalsPage({
  searchParams,
}: {
  searchParams: Promise<{
    page?: string;
    status?: string;
    verdict?: string;
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
    search: params.search?.trim().slice(0, 100) ?? "",
  };

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={ArrowUpFromLine}
          accent="cyan"
          title="Withdrawals"
          subtitle="Trace every payout back to its deposits, play, wins, and rewards"
        />
      </PageHero>

      <Filters state={state} />

      <Suspense
        key={`${state.page}-${state.status}-${state.verdict}-${state.search}`}
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
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex flex-wrap gap-1.5">
          <FilterButton label="All risk" active={!state.verdict} state={state} verdict={null} />
          <FilterButton label="Good" active={state.verdict === "good"} state={state} verdict="good" />
          <FilterButton label="Review" active={state.verdict === "review"} state={state} verdict="review" />
          <FilterButton label="Bad" active={state.verdict === "bad"} state={state} verdict="bad" />
          <span className="mx-1 hidden h-8 w-px bg-border sm:block" />
          <FilterButton label="Any status" active={!state.status} state={state} status={null} />
          <FilterButton label="Pending" active={state.status === "pending"} state={state} status="pending" />
          <FilterButton label="Processing" active={state.status === "processing"} state={state} status="processing" />
          <FilterButton label="Completed" active={state.status === "completed"} state={state} status="completed" />
        </div>
        <form className="flex w-full gap-2 xl:w-auto" action="/antifraud/withdrawals">
          {state.status && <input type="hidden" name="status" value={state.status} />}
          {state.verdict && <input type="hidden" name="verdict" value={state.verdict} />}
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

function FilterButton({
  label,
  active,
  state,
  status,
  verdict,
}: {
  label: string;
  active: boolean;
  state: FilterState;
  status?: string | null;
  verdict?: WithdrawalVerdict | null;
}) {
  const next = {
    ...state,
    page: 1,
    status: status === null ? undefined : status ?? state.status,
    verdict: verdict === null ? undefined : verdict ?? state.verdict,
  };
  return (
    <Button
      size="sm"
      variant={active ? "default" : "outline"}
      render={<HostLink href={withdrawalHref(next)} />}
    >
      {label}
    </Button>
  );
}

async function WithdrawalContent({ state }: { state: FilterState }) {
  const result = await listWithdrawalAssessments({
    page: state.page,
    status: state.status,
    verdict: state.verdict,
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
  summary: { total: number; good: number; review: number; bad: number; amount_usd: number };
}) {
  const cards = [
    { label: "Tracked", value: summary.total.toLocaleString(), icon: WalletCards, tone: "text-cyan-600 dark:text-cyan-400" },
    { label: "Good", value: summary.good.toLocaleString(), icon: ShieldCheck, tone: "text-emerald-600 dark:text-emerald-400" },
    { label: "Needs review", value: summary.review.toLocaleString(), icon: AlertTriangle, tone: "text-amber-600 dark:text-amber-400" },
    { label: "Bad", value: summary.bad.toLocaleString(), icon: ShieldAlert, tone: "text-rose-600 dark:text-rose-400" },
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {cards.map((card) => {
        const Icon = card.icon;
        return (
          <div key={card.label} className="rounded-xl border border-border/70 bg-card p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">{card.label}</span>
              <Icon className={cn("size-4", card.tone)} />
            </div>
            <p className="mt-2 text-2xl font-semibold tabular-nums">{card.value}</p>
          </div>
        );
      })}
    </div>
  );
}

function WithdrawalRow({ withdrawal }: { withdrawal: WithdrawalAssessment }) {
  const name = withdrawal.username ?? withdrawal.user_id;
  const verdict = verdictStyle(withdrawal.verdict);
  const VerdictIcon = verdict.icon;
  return (
    <article className="overflow-hidden rounded-xl border border-border/70 bg-card shadow-sm">
      <div className="flex flex-col gap-4 border-b border-border/60 p-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar className="size-10">
            {withdrawal.avatar_url && <AvatarImage src={withdrawal.avatar_url} alt="" />}
            <AvatarFallback>{name.slice(0, 2).toUpperCase()}</AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="truncate font-semibold">{name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {withdrawal.email ?? withdrawal.user_id}
            </p>
          </div>
          <Badge variant="outline" className="capitalize">
            {withdrawal.status}
          </Badge>
          <Badge variant="secondary" className="capitalize">
            {withdrawal.method}
          </Badge>
        </div>
        <div className="flex flex-wrap items-center gap-3 lg:justify-end">
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Requested</p>
            <p className="text-sm font-medium tabular-nums">
              {formatDate(withdrawal.requested_at)}
            </p>
          </div>
          <div className="min-w-28 text-right">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Withdrawal</p>
            <p className="text-lg font-semibold tabular-nums text-rose-600 dark:text-rose-400">
              {formatCurrency(withdrawal.amount_usd)}
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
        </div>
      </div>

      <div className="grid gap-5 p-4 xl:grid-cols-[minmax(0,1.65fr)_minmax(260px,0.75fr)]">
        <div className="space-y-4">
          <MoneyFlow withdrawal={withdrawal} />
          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Exact withdrawal sources
            </p>
            <div className="flex flex-wrap gap-2">
              {withdrawal.source_breakdown.length ? (
                withdrawal.source_breakdown.map((source) => (
                  <span
                    key={source.key}
                    className={cn(
                      "rounded-lg border px-2.5 py-1.5 text-xs",
                      source.traceable
                        ? "border-cyan-500/20 bg-cyan-500/5"
                        : "border-amber-500/30 bg-amber-500/5",
                    )}
                  >
                    <span className="font-medium">{source.label}</span>
                    <span className="ml-1 text-muted-foreground">
                      {source.count} · {formatCurrency(source.valueUsd)}
                    </span>
                  </span>
                ))
              ) : (
                <span className="text-xs text-muted-foreground">No attached source records.</span>
              )}
            </div>
          </div>
        </div>

        <div className={cn("rounded-xl border p-3.5", verdict.box)}>
          <div className="flex items-start gap-2">
            <VerdictIcon className={cn("mt-0.5 size-5 shrink-0", verdict.text)} />
            <div>
              <p className="text-sm font-semibold">Assessment</p>
              <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                {withdrawal.summary}
              </p>
            </div>
          </div>
          <div className="mt-3 space-y-2">
            {withdrawal.signals.slice(0, 4).map((signal) => (
              <div key={signal.key} className="flex items-start justify-between gap-2 text-xs">
                <span>
                  <span className="font-medium">{signal.label}</span>
                  <span className="block text-[11px] leading-4 text-muted-foreground">
                    {signal.detail}
                  </span>
                </span>
                {signal.points > 0 ? (
                  <Badge variant="outline" className="shrink-0 tabular-nums">
                    +{signal.points}
                  </Badge>
                ) : (
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-500" />
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </article>
  );
}

function MoneyFlow({ withdrawal }: { withdrawal: WithdrawalAssessment }) {
  const flow = withdrawal.flow;
  const steps = [
    { label: "Deposits", value: flow.depositsUsd, icon: CircleDollarSign, tone: "text-emerald-600 dark:text-emerald-400" },
    { label: "Game wins", value: flow.gameWinsUsd, icon: TrendingUp, tone: "text-rose-600 dark:text-rose-400" },
    { label: "Game losses", value: flow.gameLossesUsd, icon: TrendingDown, tone: "text-emerald-600 dark:text-emerald-400" },
    { label: "Rewards", value: flow.rewardsUsd, icon: Gift, tone: "text-rose-600 dark:text-rose-400" },
    { label: "Withdrawal", value: flow.withdrawalUsd, icon: ArrowUpFromLine, tone: "text-rose-600 dark:text-rose-400" },
  ];
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          90-day money trail
        </p>
        <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <Clock3 className="size-3" />
          {flow.gameEvents} game events
        </span>
      </div>
      <div className="grid gap-2 sm:grid-cols-5">
        {steps.map((step, index) => {
          const Icon = step.icon;
          return (
            <div key={step.label} className="relative rounded-lg border border-border/60 bg-muted/20 p-2.5">
              <Icon className={cn("mb-2 size-4", step.tone)} />
              <span className="block text-[10px] text-muted-foreground">{step.label}</span>
              <span className={cn("block text-sm font-semibold tabular-nums", step.tone)}>
                {formatCurrency(step.value)}
              </span>
              {index < steps.length - 1 && (
                <ArrowRight className="absolute -right-3 top-1/2 z-10 hidden size-4 -translate-y-1/2 rounded-full bg-card text-muted-foreground sm:block" />
              )}
            </div>
          );
        })}
      </div>
    </div>
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
      <Skeleton className="h-72 rounded-xl" />
      <Skeleton className="h-72 rounded-xl" />
    </div>
  );
}
