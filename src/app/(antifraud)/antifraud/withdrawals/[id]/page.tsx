import { notFound } from "next/navigation";
import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  BadgeCheck,
  CircleCheck,
  CircleDollarSign,
  Clock3,
  Fingerprint,
  Gauge,
  History,
  ListChecks,
  Network,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
  UserRound,
} from "lucide-react";
import { z } from "zod";

import { HostLink } from "@/components/host-link";
import {
  KpiTile,
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RiskScoreBar } from "../../_components/risk-score-bar";
import {
  getWithdrawalAssessment,
  type WithdrawalAssessment,
  type WithdrawalDetail,
  type WithdrawalReviewStatus,
} from "@/lib/antifraud/withdrawals-api";
import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";
import { cn } from "@/lib/utils";
import {
  formatCurrency,
  formatDateTime,
  formatRelative,
} from "@/lib/utils/format";
import { WithdrawalReviewControls } from "./review-controls";

export const metadata = { title: "Withdrawal Review · Antifraud" };

export default async function WithdrawalReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAntifraudPageAccess();
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();
  const result = await getWithdrawalAssessment(id);
  if (result.notFound) notFound();
  if (!result.configured) {
    return (
      <Unavailable text="The Antifraud monitor service is not configured." />
    );
  }
  if (result.error || !result.data) {
    return <Unavailable text="This withdrawal review could not be loaded." />;
  }
  return <WithdrawalReview detail={result.data} />;
}

function WithdrawalReview({ detail }: { detail: WithdrawalDetail }) {
  const withdrawal = detail.assessment;
  const name = withdrawal.username ?? withdrawal.user_id;
  const failedChecks = withdrawal.flow_checks.filter(
    (check) => check.status !== "pass",
  ).length;
  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={ShieldAlert}
          accent="cyan"
          title="Withdrawal review"
          subtitle="Behavioral payout review"
          backHref="/antifraud/withdrawals"
          action={
            <Button
              size="sm"
              variant="outline"
              render={
                <HostLink
                  href={`/antifraud/networks?user=${encodeURIComponent(withdrawal.user_id)}`}
                />
              }
            >
              <Network className="size-4" />
              Account network
            </Button>
          }
        />
      </PageHero>

      <div className="rounded-xl border bg-card p-4 sm:p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <Avatar className="size-11">
              {withdrawal.avatar_url && (
                <AvatarImage src={withdrawal.avatar_url} alt="" />
              )}
              <AvatarFallback>{name.slice(0, 2).toUpperCase()}</AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <h1 className="truncate text-lg font-semibold">{name}</h1>
              <p className="truncate text-xs text-muted-foreground">
                {withdrawal.email ?? withdrawal.user_id}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="capitalize">
              {withdrawal.method}
            </Badge>
            <Badge variant="outline" className="capitalize">
              {withdrawal.status}
            </Badge>
            <ReviewStatusBadge status={withdrawal.review_status} />
          </div>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Requested {formatDateTime(withdrawal.requested_at)} · assessed{" "}
          {formatRelative(withdrawal.assessed_at)}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile
          icon={ArrowUpFromLine}
          accent="rose"
          label="Withdrawal"
          value={formatCurrency(withdrawal.amount_usd)}
          sub={
            withdrawal.method === "balance"
              ? "paid from account balance"
              : `${withdrawal.asset_count} attached asset${withdrawal.asset_count === 1 ? "" : "s"}`
          }
        />
        <KpiTile
          icon={Gauge}
          accent={riskAccent(withdrawal.risk_score)}
          label="Automated risk"
          value={`${withdrawal.risk_score}/100`}
          sub={withdrawal.verdict}
        />
        <KpiTile
          icon={ListChecks}
          accent={failedChecks === 0 ? "emerald" : "amber"}
          label="Flow checks"
          value={`${withdrawal.flow_checks.length - failedChecks}/${withdrawal.flow_checks.length}`}
          sub={
            failedChecks === 0 ? "all passed" : `${failedChecks} need attention`
          }
        />
        <KpiTile
          icon={Clock3}
          accent="cyan"
          label="Review state"
          value={reviewStatusLabel(withdrawal.review_status)}
          sub={
            withdrawal.reviewed_by_username
              ? `by ${withdrawal.reviewed_by_username}`
              : "awaiting analyst"
          }
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,0.7fr)]">
        <div className="min-w-0 space-y-6">
          <MoneyTrail withdrawal={withdrawal} />
          <BehaviorTimeline detail={detail} />
          <FlowChecks withdrawal={withdrawal} />
          <SourceEvidence withdrawal={withdrawal} />
        </div>
        <aside className="min-w-0 space-y-5">
          <WithdrawalReviewControls
            withdrawalId={withdrawal.withdrawal_id}
            status={withdrawal.review_status}
          />
          <RiskBreakdown withdrawal={withdrawal} />
          <Assessment withdrawal={withdrawal} />
          <ReviewTrail detail={detail} />
        </aside>
      </div>
    </div>
  );
}

function FlowChecks({ withdrawal }: { withdrawal: WithdrawalAssessment }) {
  return (
    <section className="space-y-3">
      <SectionHeading
        icon={ListChecks}
        title={
          <>
            Withdrawal review flow
            <span className="text-xs font-normal text-muted-foreground">
              ordered automated checks
            </span>
          </>
        }
      />
      <div className="space-y-2">
        {withdrawal.flow_checks.map((check, index) => {
          const style = checkStyle(check.status);
          const Icon = style.icon;
          return (
            <div
              key={check.key}
              className={cn("rounded-xl border bg-card p-4", style.border)}
            >
              <div className="flex items-start gap-3">
                <div
                  className={cn(
                    "flex size-8 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
                    style.circle,
                  )}
                >
                  {index + 1}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold">{check.label}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {check.description}
                      </p>
                    </div>
                    <Badge
                      variant="outline"
                      className={cn("capitalize", style.badge)}
                    >
                      <Icon className="size-3.5" />
                      {check.status}
                      {check.score > 0 && ` · +${check.score}`}
                    </Badge>
                  </div>
                  <div className="mt-3 space-y-1">
                    {check.evidence.map((evidence) => (
                      <p
                        key={evidence}
                        className="flex items-start gap-2 text-xs leading-5 text-muted-foreground"
                      >
                        <span
                          className={cn(
                            "mt-2 size-1 shrink-0 rounded-full",
                            style.dot,
                          )}
                        />
                        {evidence}
                      </p>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function MoneyTrail({ withdrawal }: { withdrawal: WithdrawalAssessment }) {
  const flow = withdrawal.flow;
  const totals = [
    {
      label: "Deposited in trail",
      value: flow.depositsUsd,
      tone: "text-emerald-600 dark:text-emerald-400",
    },
    {
      label: "Game losses",
      value: flow.gameLossesUsd,
      tone: "text-emerald-600 dark:text-emerald-400",
    },
    {
      label: "Game wins",
      value: flow.gameWinsUsd,
      tone: "text-rose-600 dark:text-rose-400",
    },
    {
      label: "Rewards",
      value: flow.rewardsUsd,
      tone: "text-rose-600 dark:text-rose-400",
    },
  ];
  return (
    <section className="space-y-3">
      <SectionHeading
        icon={CircleDollarSign}
        title={
          <>
            How this withdrawal was funded
            <span className="text-xs font-normal text-muted-foreground">
              only activity from the latest funding origin to this request
            </span>
          </>
        }
      />
      <div className="grid gap-2 sm:grid-cols-3">
        <div className="rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-4">
          <div className="flex items-center gap-2 text-cyan-700 dark:text-cyan-300">
            <ArrowDownToLine className="size-4" />
            <span className="text-[11px] font-semibold uppercase tracking-wide">
              1. Funding origin
            </span>
          </div>
          <p className="mt-3 font-semibold">{flow.originLabel}</p>
          {flow.originAt ? (
            <>
              <p className="mt-1 text-lg font-semibold tabular-nums">
                {formatCurrency(flow.originAmountUsd)}
              </p>
              <p className="text-xs text-muted-foreground">
                {formatDateTime(flow.originAt)}
              </p>
            </>
          ) : (
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              No completed funding source was found before this request.
            </p>
          )}
        </div>
        <div className="rounded-xl border bg-card p-4">
          <div className="flex items-center gap-2 text-amber-700 dark:text-amber-300">
            <Activity className="size-4" />
            <span className="text-[11px] font-semibold uppercase tracking-wide">
              2. Activity after funding
            </span>
          </div>
          <p className="mt-3 font-semibold">
            {flow.gameEvents} game event{flow.gameEvents === 1 ? "" : "s"}
          </p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Lost {formatCurrency(flow.gameLossesUsd)} · won{" "}
            {formatCurrency(flow.gameWinsUsd)} · received{" "}
            {formatCurrency(flow.rewardsUsd)} in rewards
          </p>
        </div>
        <div className="rounded-xl border border-rose-500/20 bg-rose-500/5 p-4">
          <div className="flex items-center gap-2 text-rose-700 dark:text-rose-300">
            <ArrowUpFromLine className="size-4" />
            <span className="text-[11px] font-semibold uppercase tracking-wide">
              3. Withdrawal requested
            </span>
          </div>
          <p className="mt-3 text-lg font-semibold tabular-nums">
            {formatCurrency(flow.withdrawalUsd)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {formatDateTime(withdrawal.requested_at)}
          </p>
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-4">
        {totals.map((total) => (
          <div key={total.label} className="rounded-lg border bg-card px-3 py-2">
            <p className="text-[10px] text-muted-foreground">{total.label}</p>
            <p
              className={cn("text-sm font-semibold tabular-nums", total.tone)}
            >
              {formatCurrency(total.value)}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

function BehaviorTimeline({ detail }: { detail: WithdrawalDetail }) {
  const events =
    detail.timeline.length <= 40
      ? detail.timeline
      : [detail.timeline[0], ...detail.timeline.slice(-39)];
  return (
    <section className="space-y-3">
      <SectionHeading
        icon={History}
        title={
          <>
            Current withdrawal trail
            <span className="text-xs font-normal text-muted-foreground">
              {events.length} linked events from origin to request
            </span>
          </>
        }
      />
      <div className="overflow-hidden rounded-xl border bg-card">
        {events.map((event, index) => (
          <div
            key={event.id}
            className={cn(
              "flex gap-3 p-3 sm:p-4",
              index > 0 && "border-t border-border/60",
            )}
          >
            <div
              className={cn(
                "mt-1 size-2 shrink-0 rounded-full",
                event.tone === "good" && "bg-emerald-500",
                event.tone === "bad" && "bg-rose-500",
                event.tone === "warning" && "bg-amber-500",
                event.tone === "neutral" && "bg-cyan-500",
              )}
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-medium capitalize">
                      {event.label}
                    </p>
                    {event.isOrigin && (
                      <Badge
                        variant="outline"
                        className="border-cyan-500/30 text-[10px] text-cyan-700 dark:text-cyan-300"
                      >
                        Origin
                      </Badge>
                    )}
                  </div>
                  {event.detail && (
                    <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                      {event.detail}
                    </p>
                  )}
                </div>
                <div className="shrink-0 text-right">
                  {event.amountUsd > 0 && (
                    <p
                      className={cn(
                        "text-xs font-semibold tabular-nums",
                        event.tone === "good"
                          ? "text-emerald-600 dark:text-emerald-400"
                          : event.tone === "bad"
                            ? "text-rose-600 dark:text-rose-400"
                            : "text-foreground",
                      )}
                    >
                      {formatCurrency(event.amountUsd)}
                    </p>
                  )}
                  <p className="text-[10px] text-muted-foreground">
                    {formatDateTime(event.occurredAt)}
                  </p>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function SourceEvidence({ withdrawal }: { withdrawal: WithdrawalAssessment }) {
  const isBalanceWithdrawal = withdrawal.method === "balance";
  return (
    <section className="space-y-3">
      <SectionHeading
        icon={Fingerprint}
        title={
          <>
            Attached assets
            <span className="text-xs font-normal text-muted-foreground">
              {isBalanceWithdrawal
                ? "not used for balance withdrawals"
                : "cards and vouchers included in this request"}
            </span>
          </>
        }
      />
      <div className="grid gap-2 sm:grid-cols-2">
        {isBalanceWithdrawal ? (
          <div className="flex items-start gap-3 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-4 sm:col-span-2">
            <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-500" />
            <div>
              <p className="text-xs font-semibold">
                No asset attachment required
              </p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                This withdrawal is paid from account balance. Missing card or
                voucher records are expected and do not add risk.
              </p>
            </div>
          </div>
        ) : withdrawal.source_breakdown.length > 0 ? (
          withdrawal.source_breakdown.map((source) => (
            <div
              key={source.key}
              className={cn(
                "rounded-lg border bg-card p-3",
                source.traceable
                  ? "border-emerald-500/20"
                  : "border-amber-500/30",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-semibold">{source.label}</p>
                {source.traceable ? (
                  <BadgeCheck className="size-4 text-emerald-500" />
                ) : (
                  <TriangleAlert className="size-4 text-amber-500" />
                )}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {source.count} item{source.count === 1 ? "" : "s"} ·{" "}
                {formatCurrency(source.valueUsd)}
              </p>
            </div>
          ))
        ) : (
          <div className="rounded-lg border border-dashed border-amber-500/30 bg-amber-500/5 p-4 text-xs text-muted-foreground sm:col-span-2">
            This asset-based withdrawal has no attached card or voucher source
            records.
          </div>
        )}
      </div>
    </section>
  );
}

function RiskBreakdown({ withdrawal }: { withdrawal: WithdrawalAssessment }) {
  const labels: {
    key: keyof WithdrawalAssessment["score_breakdown"];
    label: string;
  }[] = [
    { key: "integrity", label: "Integrity" },
    { key: "funding", label: "Funding" },
    { key: "behavior", label: "Behavior" },
    { key: "account", label: "Account" },
    { key: "network", label: "Network" },
  ];
  return (
    <div className="rounded-xl border bg-card p-4">
      <p className="text-sm font-semibold">Risk breakdown</p>
      <div className="mt-4 space-y-3">
        {labels.map(({ key, label }) => {
          const score = withdrawal.score_breakdown[key];
          return (
            <div key={key}>
              <div className="mb-1 flex justify-between text-xs">
                <span className="text-muted-foreground">{label}</span>
                <span className="font-semibold tabular-nums">{score}</span>
              </div>
              <RiskScoreBar score={score} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Assessment({ withdrawal }: { withdrawal: WithdrawalAssessment }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-center gap-2">
        <ShieldCheck className="size-4 text-cyan-500" />
        <p className="text-sm font-semibold">Automated assessment</p>
      </div>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">
        {withdrawal.summary}
      </p>
      <div className="mt-4 space-y-2">
        {withdrawal.signals.map((signal) => (
          <div
            key={signal.key}
            className="flex items-start justify-between gap-2 rounded-lg border border-border/60 p-2.5"
          >
            <div className="min-w-0">
              <p className="text-xs font-medium">{signal.label}</p>
              <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                {signal.detail}
              </p>
            </div>
            <Badge variant="outline" className="shrink-0">
              {signal.points > 0 ? `+${signal.points}` : "Pass"}
            </Badge>
          </div>
        ))}
      </div>
    </div>
  );
}

function ReviewTrail({ detail }: { detail: WithdrawalDetail }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-center gap-2">
        <History className="size-4 text-cyan-500" />
        <p className="text-sm font-semibold">Review trail</p>
      </div>
      <div className="mt-3 space-y-3">
        {detail.reviewEvents.length > 0 ? (
          detail.reviewEvents.map((event) => (
            <div key={event.id} className="border-l-2 border-cyan-500/30 pl-3">
              <p className="text-xs font-medium capitalize">
                {event.action.replaceAll("_", " ")}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {event.actor_username ?? event.actor_id} ·{" "}
                {formatDateTime(event.created_at)}
              </p>
              {event.note && (
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {event.note}
                </p>
              )}
            </div>
          ))
        ) : (
          <p className="text-xs text-muted-foreground">
            No analyst decision has been recorded yet.
          </p>
        )}
      </div>
    </div>
  );
}

function ReviewStatusBadge({ status }: { status: WithdrawalReviewStatus }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        status === "cleared" &&
          "border-emerald-500/30 text-emerald-600 dark:text-emerald-400",
        status === "in_review" &&
          "border-cyan-500/30 text-cyan-600 dark:text-cyan-400",
        status === "escalated" &&
          "border-amber-500/30 text-amber-600 dark:text-amber-400",
        status === "block_recommended" &&
          "border-rose-500/30 text-rose-600 dark:text-rose-400",
      )}
    >
      {reviewStatusLabel(status)}
    </Badge>
  );
}

function reviewStatusLabel(status: WithdrawalReviewStatus): string {
  const labels: Record<WithdrawalReviewStatus, string> = {
    unreviewed: "Unreviewed",
    in_review: "In review",
    cleared: "Cleared",
    escalated: "Escalated",
    block_recommended: "Block recommended",
  };
  return labels[status];
}

function riskAccent(score: number): "emerald" | "amber" | "rose" {
  if (score >= 60) return "rose";
  if (score >= 30) return "amber";
  return "emerald";
}

function checkStyle(status: "pass" | "review" | "block") {
  if (status === "pass") {
    return {
      icon: CircleCheck,
      border: "border-emerald-500/20",
      circle:
        "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
      badge: "border-emerald-500/30 text-emerald-600 dark:text-emerald-400",
      dot: "bg-emerald-500",
    };
  }
  if (status === "block") {
    return {
      icon: ShieldAlert,
      border: "border-rose-500/25",
      circle:
        "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400",
      badge: "border-rose-500/30 text-rose-600 dark:text-rose-400",
      dot: "bg-rose-500",
    };
  }
  return {
    icon: TriangleAlert,
    border: "border-amber-500/25",
    circle:
      "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
    badge: "border-amber-500/30 text-amber-600 dark:text-amber-400",
    dot: "bg-amber-500",
  };
}

function Unavailable({ text }: { text: string }) {
  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={ShieldAlert}
          accent="cyan"
          title="Withdrawal review"
          subtitle="Behavioral payout review"
          backHref="/antifraud/withdrawals"
        />
      </PageHero>
      <div className="rounded-xl border border-dashed bg-card/40 px-4 py-14 text-center">
        <UserRound className="mx-auto mb-3 size-6 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{text}</p>
      </div>
    </div>
  );
}
