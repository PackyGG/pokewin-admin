import { Suspense } from "react";
import {
  ArrowRight,
  Banknote,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CreditCard,
  Search,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";

import { HostLink } from "@/components/host-link";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  listFiatAssessments,
  type FiatAssessment,
  type FiatReviewStatus,
  type FiatSummary,
  type FiatVerdict,
} from "@/lib/antifraud/fiat-deposits-api";
import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils/format";

export const metadata = { title: "Fiat Deposits · Antifraud" };

const STATUSES = [
  "completed",
  "partially_refunded",
  "refunded",
  "disputed",
  "paid_unreconciled",
] as const;
const VERDICTS = ["good", "review", "bad"] as const;
const REVIEWS = [
  "unreviewed",
  "in_review",
  "cleared",
  "escalated",
  "hold_recommended",
] as const;

type Filters = {
  page: number;
  status?: string;
  verdict?: FiatVerdict;
  reviewStatus?: FiatReviewStatus;
  search: string;
};

export default async function FiatDepositsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAntifraudPageAccess();
  const params = await searchParams;
  const value = (key: string) =>
    typeof params[key] === "string" ? params[key] : undefined;
  const rawPage = Number(value("page") ?? "1");
  const state: Filters = {
    page: Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1,
    status: STATUSES.includes(value("status") as (typeof STATUSES)[number])
      ? value("status")
      : undefined,
    verdict: VERDICTS.includes(value("verdict") as FiatVerdict)
      ? (value("verdict") as FiatVerdict)
      : undefined,
    reviewStatus: REVIEWS.includes(value("reviewStatus") as FiatReviewStatus)
      ? (value("reviewStatus") as FiatReviewStatus)
      : undefined,
    search: value("search")?.trim().slice(0, 100) ?? "",
  };
  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Banknote}
          accent="cyan"
          title="Fiat deposit risk"
          subtitle="Paid Whop deposits only, with 3DS, funding history, account links, and post-deposit money movement"
        />
      </PageHero>
      <FiltersBar state={state} />
      <Suspense
        key={JSON.stringify(state)}
        fallback={<FiatListSkeleton />}
      >
        <FiatContent state={state} />
      </Suspense>
    </div>
  );
}

function FiltersBar({ state }: { state: Filters }) {
  return (
    <div className="rounded-xl border border-border/70 bg-card p-3">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex flex-wrap gap-1.5">
          <Filter label="All risk" active={!state.verdict} state={state} verdict={null} />
          <Filter label="Good" active={state.verdict === "good"} state={state} verdict="good" />
          <Filter label="Review" active={state.verdict === "review"} state={state} verdict="review" />
          <Filter label="High risk" active={state.verdict === "bad"} state={state} verdict="bad" />
          <span className="mx-1 hidden h-8 w-px bg-border sm:block" />
          <Filter label="Unreviewed" active={state.reviewStatus === "unreviewed"} state={state} reviewStatus="unreviewed" />
          <Filter label="In review" active={state.reviewStatus === "in_review"} state={state} reviewStatus="in_review" />
          <Filter label="Escalated" active={state.reviewStatus === "escalated"} state={state} reviewStatus="escalated" />
          <Filter label="All workflow" active={!state.reviewStatus} state={state} reviewStatus={null} />
          <span className="mx-1 hidden h-8 w-px bg-border sm:block" />
          <Filter label="All paid" active={!state.status} state={state} status={null} />
          <Filter label="Completed" active={state.status === "completed"} state={state} status="completed" />
          <Filter label="Refunded" active={state.status === "refunded"} state={state} status="refunded" />
          <Filter label="Partial refund" active={state.status === "partially_refunded"} state={state} status="partially_refunded" />
          <Filter label="Disputed" active={state.status === "disputed"} state={state} status="disputed" />
          <Filter label="Reconciliation failed" active={state.status === "paid_unreconciled"} state={state} status="paid_unreconciled" />
        </div>
        <form className="flex w-full gap-2 xl:w-auto" action="/antifraud/fiat-deposits">
          {state.status && <input type="hidden" name="status" value={state.status} />}
          {state.verdict && <input type="hidden" name="verdict" value={state.verdict} />}
          {state.reviewStatus && <input type="hidden" name="reviewStatus" value={state.reviewStatus} />}
          <Input
            name="search"
            defaultValue={state.search}
            placeholder="User, email, payment, or ID"
            maxLength={100}
            aria-label="Search fiat deposits"
            className="min-w-0 xl:w-72"
          />
          <Button type="submit" variant="outline" aria-label="Search">
            <Search className="size-4" />
          </Button>
        </form>
      </div>
    </div>
  );
}

function Filter({
  label,
  active,
  state,
  status,
  verdict,
  reviewStatus,
}: {
  label: string;
  active: boolean;
  state: Filters;
  status?: string | null;
  verdict?: FiatVerdict | null;
  reviewStatus?: FiatReviewStatus | null;
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
    <Button
      size="sm"
      variant={active ? "default" : "outline"}
      render={<HostLink href={href(next)} />}
    >
      {label}
    </Button>
  );
}

async function FiatContent({ state }: { state: Filters }) {
  const result = await listFiatAssessments({
    page: state.page,
    status: state.status,
    verdict: state.verdict,
    reviewStatus: state.reviewStatus,
    search: state.search || undefined,
  });
  if (!result.configured) return <Empty text="The Antifraud monitor is not configured." />;
  if (result.error) return <Empty text="Fiat risk assessments could not be loaded." />;
  return (
    <div className="space-y-4">
      {result.summary && <Summary summary={result.summary} />}
      {result.data.length === 0 ? (
        <Empty text="No paid fiat deposits match these filters." />
      ) : (
        <div className="space-y-3">
          {result.data.map((item) => (
            <FiatRow key={item.deposit_intent_id} item={item} />
          ))}
        </div>
      )}
      {result.pagination && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            Page {result.pagination.page} of {result.pagination.pages} ·{" "}
            {result.pagination.total} deposits
          </span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={state.page <= 1}
              render={state.page > 1 ? <HostLink href={href({ ...state, page: state.page - 1 })} /> : undefined}
            >
              <ChevronLeft className="size-3.5" /> Previous
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={state.page >= result.pagination.pages}
              render={state.page < result.pagination.pages ? <HostLink href={href({ ...state, page: state.page + 1 })} /> : undefined}
            >
              Next <ChevronRight className="size-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Summary({ summary }: { summary: FiatSummary }) {
  const cards = [
    { label: "Unreviewed", value: summary.unreviewed, sub: `${summary.total} assessed`, icon: CreditCard, tone: "text-cyan-500" },
    { label: "High risk", value: summary.bad, sub: `${summary.hold_recommended} holds advised`, icon: ShieldAlert, tone: "text-rose-500" },
    { label: "Provider flags", value: summary.provider_high_risk + summary.three_ds_failed, sub: `${summary.disputed} disputed`, icon: CircleAlert, tone: "text-amber-500" },
    { label: "Assessed volume", value: formatCurrency(summary.amount_usd), sub: `${summary.good} low risk`, icon: Banknote, tone: "text-emerald-500" },
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      {cards.map(({ label, value, sub, icon: Icon, tone }) => (
        <div key={label} className="rounded-xl border border-border/70 bg-card p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">{label}</span>
            <Icon className={cn("size-4", tone)} />
          </div>
          <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
          <p className="mt-1 text-[11px] text-muted-foreground">{sub}</p>
        </div>
      ))}
      <FiatRiskScoreGuide />
    </div>
  );
}

function FiatRiskScoreGuide() {
  return (
    <div className="rounded-xl border border-border/70 bg-card p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">
          Risk score guide
        </span>
        <ShieldCheck className="size-4 text-violet-500" />
      </div>
      <div
        className="mt-4"
        role="img"
        aria-label="Risk score guide: 0 to 29 is good, 30 to 59 needs review, and 60 to 100 is high risk"
      >
        <div className="flex h-2.5 overflow-hidden rounded-full">
          <span className="w-[30%] bg-emerald-500" aria-hidden />
          <span className="w-[30%] bg-amber-400" aria-hidden />
          <span className="w-[40%] bg-rose-500" aria-hidden />
        </div>
        <div className="mt-2 grid grid-cols-[3fr_3fr_4fr] text-[9px] font-semibold leading-tight">
          <span className="text-emerald-600 dark:text-emerald-400">
            Good
            <span className="block font-normal text-muted-foreground">
              0–29
            </span>
          </span>
          <span className="text-center text-amber-600 dark:text-amber-400">
            Review
            <span className="block font-normal text-muted-foreground">
              30–59
            </span>
          </span>
          <span className="text-right text-rose-600 dark:text-rose-400">
            High risk
            <span className="block font-normal text-muted-foreground">
              60–100
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}

function FiatRow({ item }: { item: FiatAssessment }) {
  const style = verdictStyle(item.verdict);
  const VerdictIcon = style.icon;
  const name = item.username ?? item.user_id;
  const funding = item.funding_evidence;
  const behavior = item.behavior_evidence;
  const unreconciled = item.status === "paid_unreconciled";
  return (
    <article className="overflow-hidden rounded-xl border border-border/70 bg-card shadow-sm">
      <div className="flex flex-col gap-4 border-b border-border/60 p-4 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar className="size-10">
            {item.avatar_url && <AvatarImage src={item.avatar_url} alt="" />}
            <AvatarFallback>{name.slice(0, 2).toUpperCase()}</AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="truncate font-semibold">{name}</p>
            <p className="truncate text-xs text-muted-foreground">{item.email ?? item.user_id}</p>
            <p
              className="truncate text-xs text-muted-foreground"
              title={item.provider_evidence.checkoutEmail ?? undefined}
            >
              Whop checkout: {item.provider_evidence.checkoutEmail ?? "unavailable"}
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Country:{" "}
              <span className="font-medium text-foreground">
                {item.account_evidence.countryCode?.toUpperCase() ?? "Unknown"}
              </span>
            </p>
          </div>
          <Badge
            variant="outline"
            className={cn(
              "capitalize",
              unreconciled &&
                "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400",
            )}
          >
            {unreconciled
              ? "Paid · reconciliation failed"
              : item.status.replaceAll("_", " ")}
          </Badge>
        </div>
        <div className="flex flex-wrap items-center gap-3 xl:justify-end">
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {unreconciled ? "Whop paid" : "Deposited"}
            </p>
            <p className="text-sm font-medium tabular-nums">{formatDate(item.occurred_at)}</p>
          </div>
          <div className="min-w-24 text-right">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {unreconciled ? "Expected credit" : "Credited"}
            </p>
            <p className="text-lg font-semibold tabular-nums">{formatCurrency(item.credited_amount_usd)}</p>
          </div>
          <div className={cn("flex min-w-32 items-center gap-2 rounded-lg border px-3 py-2", style.box)}>
            <VerdictIcon className={cn("size-5", style.text)} />
            <span>
              <span className={cn("block text-sm font-semibold capitalize", style.text)}>{item.verdict}</span>
              <span className="block text-[10px] text-muted-foreground">{item.risk_score}/100 risk</span>
            </span>
          </div>
          <Button size="sm" render={<HostLink href={`/antifraud/fiat-deposits/${item.deposit_intent_id}`} />}>
            Open review <ArrowRight className="size-3.5" />
          </Button>
        </div>
      </div>
      <div className="grid gap-4 p-4 xl:grid-cols-[1.25fr_1fr_1fr]">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Decision</p>
          <p className="mt-1 text-sm font-medium">{item.recommendation}</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{item.summary}</p>
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <Metric label="Whop score" value={item.provider_risk_score === null ? "No result" : `${item.provider_risk_score}/100`} />
          <Metric label="3DS" value={item.three_ds_verified === true ? "Verified" : item.three_ds_verified === false ? "Not verified" : "Pending"} />
          <Metric label="Prior crypto" value={`${funding.priorCryptoDeposits} · ${formatCurrency(funding.priorCryptoUsd)}`} />
          <Metric label="Prior fiat" value={`${funding.priorFiatDeposits} · ${formatCurrency(funding.priorFiatUsd)}`} />
        </div>
        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Six-point flow</p>
            <Badge variant="secondary" className="capitalize">{item.review_status.replaceAll("_", " ")}</Badge>
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            {item.flow_checks.map((check) => (
              <div key={check.key} className={cn(
                "rounded-md border px-2 py-1.5 text-[10px]",
                check.status === "pass" && "border-emerald-500/25 bg-emerald-500/5",
                check.status === "review" && "border-amber-500/25 bg-amber-500/5",
                check.status === "block" && "border-rose-500/25 bg-rose-500/5",
              )}>
                <span className="block truncate font-medium">{check.label}</span>
                <span className="text-muted-foreground">{check.score} pts</span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            {behavior.withdrawalRequests} later withdrawals · {(behavior.playthroughRatio * 100).toFixed(0)}% play-through
          </p>
        </div>
      </div>
    </article>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 p-2.5">
      <span className="block text-[10px] text-muted-foreground">{label}</span>
      <span className="mt-0.5 block truncate font-medium">{value}</span>
    </div>
  );
}

function verdictStyle(verdict: FiatVerdict) {
  if (verdict === "good") return { icon: ShieldCheck, text: "text-emerald-500", box: "border-emerald-500/25 bg-emerald-500/5" };
  if (verdict === "bad") return { icon: ShieldAlert, text: "text-rose-500", box: "border-rose-500/25 bg-rose-500/5" };
  return { icon: CircleAlert, text: "text-amber-500", box: "border-amber-500/25 bg-amber-500/5" };
}

function href(state: Filters) {
  const params = new URLSearchParams();
  if (state.page > 1) params.set("page", String(state.page));
  if (state.status) params.set("status", state.status);
  if (state.verdict) params.set("verdict", state.verdict);
  if (state.reviewStatus) params.set("reviewStatus", state.reviewStatus);
  if (state.search) params.set("search", state.search);
  const query = params.toString();
  return `/antifraud/fiat-deposits${query ? `?${query}` : ""}`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function Empty({ text }: { text: string }) {
  return (
    <div className="rounded-xl border border-dashed p-10 text-center">
      <CreditCard className="mx-auto size-7 text-muted-foreground" />
      <p className="mt-3 text-sm text-muted-foreground">{text}</p>
    </div>
  );
}

function FiatListSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {Array.from({ length: 5 }).map((_, index) => <Skeleton key={index} className="h-28 rounded-xl" />)}
      </div>
      {Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-56 rounded-xl" />)}
    </div>
  );
}
