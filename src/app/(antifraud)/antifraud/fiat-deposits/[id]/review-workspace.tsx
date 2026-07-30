import { notFound } from "next/navigation";
import {
  Banknote,
  CircleCheck,
  Clock3,
  CreditCard,
  Fingerprint,
  Gauge,
  History,
  ListChecks,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
  UserRound,
  WalletCards,
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
  getFiatAssessment,
  type FiatAssessment,
  type FiatDetail,
  type FiatReviewStatus,
} from "@/lib/antifraud/fiat-deposits-api";
import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";
import { canManageAntifraud } from "@/lib/antifraud/access";
import { safeQuery } from "@/lib/errors/safe-query";
import {
  getWhopRefundStates,
  type WhopRefundState,
} from "@/lib/queries/whop-refunds";
import { cn } from "@/lib/utils";
import {
  formatCurrency,
  formatDateTime,
  formatRelative,
} from "@/lib/utils/format";
import { whopPaymentMethodLabel } from "@/lib/whop-payment-method";
import { FiatReviewControls } from "./review-controls";

export const metadata = { title: "Fiat Deposit Review · Antifraud" };

export default async function FiatDepositReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireAntifraudPageAccess();
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();
  const result = await getFiatAssessment(id);
  if (result.notFound) notFound();
  if (!result.configured) {
    return (
      <Unavailable text="The Antifraud monitor service is not configured." />
    );
  }
  if (result.error || !result.data) {
    return <Unavailable text="This fiat deposit review could not be loaded." />;
  }
  const paymentId = result.data.assessment.provider_payment_id;
  const { data: refundStates } = await safeQuery(
    () => getWhopRefundStates(paymentId ? [paymentId] : []),
    new Map<string, WhopRefundState>(),
    "antifraud.fiatDeposit.refundState",
    3_000,
  );
  return (
    <FiatReview
      detail={result.data}
      canRefund={canManageAntifraud(session)}
      refundState={paymentId ? refundStates.get(paymentId) : undefined}
    />
  );
}

export function FiatReview({
  detail,
  canRefund,
  refundState,
  embedded = false,
}: {
  detail: FiatDetail;
  canRefund: boolean;
  refundState?: WhopRefundState;
  embedded?: boolean;
}) {
  const item = detail.assessment;
  const name = item.username ?? item.user_id;
  const unreconciled = item.status === "paid_unreconciled";
  const failedChecks = item.flow_checks.filter(
    (check) => check.status === "review" || check.status === "block",
  ).length;
  return (
    <div className="space-y-6">
      {!embedded && (
        <PageHero>
          <PageHeroIdentity
            backHref="/antifraud/fiat-deposits"
            action={
              <>
                <Button
                  size="sm"
                  variant="outline"
                  render={<HostLink href={`/users/${item.user_id}`} />}
                >
                  <UserRound className="size-4" />
                  User profile
                </Button>
                {canRefund && unreconciled && item.provider_payment_id && (
                  <Button
                    size="sm"
                    variant="destructive"
                    render={
                      <HostLink
                        href={`/antifraud/refunds?payment=${encodeURIComponent(item.provider_payment_id)}`}
                      />
                    }
                  >
                    <RotateCcw className="size-4" />
                    Review refund
                  </Button>
                )}
              </>
            }
          />
        </PageHero>
      )}

      <div className="rounded-xl border border-border/60 bg-card p-4 sm:p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <Avatar className="size-11">
              {item.avatar_url && <AvatarImage src={item.avatar_url} alt="" />}
              <AvatarFallback>{name.slice(0, 2).toUpperCase()}</AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <h1 className="truncate text-lg font-semibold">{name}</h1>
              <p className="truncate text-xs text-muted-foreground">
                {item.email ?? item.user_id}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="capitalize">
              {item.provider}
            </Badge>
            <Badge
              variant="outline"
              className={cn(
                "capitalize",
                unreconciled &&
                  "border-rose-500/30 text-rose-600 dark:text-rose-400",
              )}
            >
              {unreconciled
                ? "Paid · reconciliation failed"
                : item.status.replaceAll("_", " ")}
            </Badge>
            <ReviewStatusBadge status={item.review_status} />
            {refundState && (
              <Badge
                variant={
                  refundState === "succeeded" ||
                  refundState === "already_refunded"
                    ? "secondary"
                    : refundState === "pending" || refundState === "processing"
                      ? "outline"
                      : "destructive"
                }
              >
                {refundState === "succeeded" ||
                refundState === "already_refunded"
                  ? "Refunded"
                  : refundState === "pending" || refundState === "processing"
                    ? "Refund queued"
                    : "Refund needs review"}
              </Badge>
            )}
          </div>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          {unreconciled ? "Whop paid" : "Deposited"}{" "}
          {formatDateTime(item.occurred_at)} · assessed{" "}
          {formatRelative(item.assessed_at)}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile
          icon={Banknote}
          accent="cyan"
          label={unreconciled ? "Expected credit" : "Credited"}
          value={formatCurrency(item.credited_amount_usd)}
          sub={
            item.customer_total_usd === null
              ? "customer total unknown"
              : `customer paid ${formatCurrency(item.customer_total_usd)}`
          }
        />
        <KpiTile
          icon={Gauge}
          accent={riskAccent(item.risk_score)}
          label="Deposit risk"
          value={`${item.risk_score}/100`}
          sub={item.verdict}
        />
        <KpiTile
          icon={ListChecks}
          accent={failedChecks === 0 ? "emerald" : "amber"}
          label="Flow checks"
          value={`${item.flow_checks.length - failedChecks}/${item.flow_checks.length}`}
          sub={
            failedChecks === 0 ? "all passed" : `${failedChecks} need attention`
          }
        />
        <KpiTile
          icon={Clock3}
          accent="cyan"
          label="Review state"
          value={reviewStatusLabel(item.review_status)}
          sub={
            item.reviewed_by_username
              ? `by ${item.reviewed_by_username}`
              : "awaiting analyst"
          }
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,0.7fr)]">
        <div className="min-w-0 space-y-6">
          <FlowChecks item={item} />
          <MoneyTrail detail={detail} />
          <PostDepositBehavior item={item} />
          <ProviderEvidence item={item} />
        </div>
        <aside className="min-w-0 space-y-6">
          <FiatReviewControls
            depositIntentId={item.deposit_intent_id}
            status={item.review_status}
          />
          <RiskBreakdown item={item} />
          <Assessment item={item} />
          <ReviewTrail detail={detail} />
        </aside>
      </div>
    </div>
  );
}

function FlowChecks({ item }: { item: FiatAssessment }) {
  return (
    <section className="space-y-3">
      <SectionHeading
        icon={ListChecks}
        title={
          <>
            Deposit review flow
            <span className="text-xs font-normal text-muted-foreground">
              ordered automated checks
            </span>
          </>
        }
      />
      <div className="space-y-2">
        {item.flow_checks.map((check, index) => {
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

function MoneyTrail({ detail }: { detail: FiatDetail }) {
  const events = detail.timeline;
  return (
    <section className="space-y-3">
      <SectionHeading
        icon={History}
        title={
          <>
            Money trail
            <span className="text-xs font-normal text-muted-foreground">
              funding before this payment, then play and cash-outs after it
            </span>
          </>
        }
      />
      {events.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/70 bg-card/40 p-6 text-center text-xs text-muted-foreground">
          No linked money movement was found around this deposit.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border/60 bg-card">
          {events.map((event, index) => (
            <div
              key={event.id}
              className={cn(
                "flex gap-3 p-3 sm:p-4",
                index > 0 && "border-t border-border/60",
                event.isCurrent && "bg-cyan-500/5",
              )}
            >
              <div
                className={cn(
                  "mt-1 size-2 shrink-0 rounded-full",
                  event.isCurrent
                    ? "bg-cyan-500"
                    : event.tone === "good"
                      ? "bg-emerald-500"
                      : event.tone === "bad"
                        ? "bg-rose-500"
                        : event.tone === "warning"
                          ? "bg-amber-500"
                          : "bg-muted-foreground/50",
                )}
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium capitalize">
                      {event.label}
                      {event.isCurrent && (
                        <Badge
                          variant="outline"
                          className="ml-2 border-cyan-500/30 text-[10px] text-cyan-600 dark:text-cyan-400"
                        >
                          This deposit
                        </Badge>
                      )}
                    </p>
                    {event.detail && (
                      <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                        {event.detail}
                      </p>
                    )}
                  </div>
                  <div className="shrink-0 text-right">
                    {event.amountUsd > 0 && (
                      <p className="text-xs font-semibold tabular-nums">
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
      )}
    </section>
  );
}

function PostDepositBehavior({ item }: { item: FiatAssessment }) {
  const behavior = item.behavior_evidence;
  const funding = item.funding_evidence;
  const account = item.account_evidence;
  const tiles: { label: string; value: string; sub?: string }[] = [
    {
      label: "Wagered after",
      value: formatCurrency(behavior.gameWagerUsd),
      sub: `${(behavior.playthroughRatio * 100).toFixed(0)}% play-through`,
    },
    {
      label: "Game payouts",
      value: formatCurrency(behavior.gamePayoutUsd),
      sub: `${behavior.gameEvents.toLocaleString()} play events`,
    },
    {
      label: "Withdrawals after",
      value: formatCurrency(behavior.withdrawalUsd),
      sub: `${behavior.withdrawalRequests} request${behavior.withdrawalRequests === 1 ? "" : "s"}`,
    },
    {
      label: "First cash-out",
      value:
        behavior.minutesToFirstWithdrawal === null
          ? "None"
          : `${behavior.minutesToFirstWithdrawal.toFixed(0)} min`,
      sub: `${behavior.observedHours.toFixed(0)}h observed`,
    },
    {
      label: "Prior crypto",
      value: formatCurrency(funding.priorCryptoUsd),
      sub: `${funding.priorCryptoDeposits} deposit${funding.priorCryptoDeposits === 1 ? "" : "s"}`,
    },
    {
      label: "Prior fiat",
      value: formatCurrency(funding.priorFiatUsd),
      sub: `${funding.priorFiatDeposits} deposit${funding.priorFiatDeposits === 1 ? "" : "s"}`,
    },
    {
      label: "Size vs average",
      value:
        funding.currentVsAverageRatio === null
          ? "First deposit"
          : `${funding.currentVsAverageRatio.toFixed(1)}x`,
      sub:
        funding.priorDepositAverageUsd > 0
          ? `avg ${formatCurrency(funding.priorDepositAverageUsd)}`
          : undefined,
    },
    {
      label: "Fiat attempts",
      value: `${account.fiatAttempts1h}/h · ${account.fiatAttempts24h}/d`,
      sub:
        account.failedFiatAttempts24h > 0
          ? `${account.failedFiatAttempts24h} failed today`
          : "no failures today",
    },
  ];
  return (
    <section className="space-y-3">
      <SectionHeading
        icon={WalletCards}
        title={
          <>
            Funding &amp; behavior
            <span className="text-xs font-normal text-muted-foreground">
              deposit history and what happened after the money landed
            </span>
          </>
        }
      />
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((tile) => (
          <div
            key={tile.label}
            className="rounded-lg border border-border/60 bg-card p-3"
          >
            <p className="text-[10px] text-muted-foreground">{tile.label}</p>
            <p className="mt-1 text-sm font-semibold tabular-nums">
              {tile.value}
            </p>
            {tile.sub && (
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {tile.sub}
              </p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function ProviderEvidence({ item }: { item: FiatAssessment }) {
  const provider = item.provider_evidence;
  const account = item.account_evidence;
  const facts: { label: string; value: string; alert?: boolean }[] = [
    {
      label: "Whop risk score",
      value:
        provider.riskScore === null ? "No result" : `${provider.riskScore}/100`,
      alert: provider.riskScore !== null && provider.riskScore >= 60,
    },
    {
      label: "3DS authentication",
      value:
        provider.threeDsVerified === true
          ? "Verified"
          : provider.threeDsVerified === false
            ? "Not verified"
            : "No result",
      alert: provider.threeDsVerified === false,
    },
    {
      label: "Disputes / refunds",
      value: `${provider.disputeCount} / ${provider.refundCount}`,
      alert: provider.disputeCount > 0,
    },
    {
      label: "Payment option",
      value: whopPaymentMethodLabel(provider.paymentMethodType),
    },
    {
      label: "Billing country",
      value: provider.billingCountry ?? account.countryCode ?? "Unknown",
    },
    {
      label: "Account age",
      value: `${account.accountAgeDays.toFixed(1)} days`,
    },
    { label: "KYC", value: account.kycStatus },
    {
      label: "Shared device",
      value: `${account.sharedDeviceUsers} other user${account.sharedDeviceUsers === 1 ? "" : "s"}`,
      alert: account.sharedDeviceUsers > 0,
    },
    {
      label: "Shared signup IP",
      value: `${account.sharedSignupIpUsers} other user${account.sharedSignupIpUsers === 1 ? "" : "s"}`,
      alert: account.sharedSignupIpUsers > 0,
    },
    {
      label: "Restrictions",
      value:
        account.isBanned || account.isLocked
          ? [account.isBanned && "banned", account.isLocked && "locked"]
              .filter(Boolean)
              .join(" · ")
          : "None",
      alert: account.isBanned || account.isLocked,
    },
    {
      label: "Suspected alt",
      value: account.isSuspectedAlt ? "Yes" : "No",
      alert: account.isSuspectedAlt,
    },
    {
      label: "Prior disputed / refunded fiat",
      value: `${account.priorDisputedFiat} / ${account.priorRefundedFiat}`,
      alert: account.priorDisputedFiat > 0,
    },
  ];
  return (
    <section className="space-y-3">
      <SectionHeading
        icon={Fingerprint}
        title={
          <>
            Provider &amp; account evidence
            <span className="text-xs font-normal text-muted-foreground">
              only risk fields — card and billing identity data are not copied
              into Antifraud
            </span>
          </>
        }
      />
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {facts.map((fact) => (
          <div
            key={fact.label}
            className={cn(
              "rounded-lg border border-border/60 bg-card p-3",
              fact.alert && "border-amber-500/30",
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <p className="text-[10px] text-muted-foreground">{fact.label}</p>
              {fact.alert && (
                <TriangleAlert className="size-3.5 shrink-0 text-amber-500" />
              )}
            </div>
            <p className="mt-1 truncate text-sm font-semibold capitalize">
              {fact.value}
            </p>
          </div>
        ))}
      </div>
      {provider.riskSignals.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-border/60 bg-card">
          <p className="border-b border-border/60 px-4 py-2.5 text-xs font-semibold">
            Raw Whop risk signals
          </p>
          <div className="grid gap-x-4 p-2 sm:grid-cols-2">
            {provider.riskSignals.map((signal) => (
              <div
                key={signal.key}
                className="flex items-start justify-between gap-3 px-2 py-1.5 text-xs"
              >
                <span className="text-muted-foreground">{signal.label}</span>
                <span className="break-words text-right font-medium">
                  {String(signal.value ?? "No result")}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

const BREAKDOWN_LABELS: { key: FiatCategory; label: string }[] = [
  { key: "provider", label: "Provider" },
  { key: "funding", label: "Funding" },
  { key: "velocity", label: "Velocity" },
  { key: "account", label: "Account" },
  { key: "network", label: "Network" },
  { key: "behavior", label: "Behavior" },
];

type FiatCategory = keyof FiatAssessment["score_breakdown"];

function RiskBreakdown({ item }: { item: FiatAssessment }) {
  return (
    <div className="rounded-xl border border-border/60 bg-card p-4">
      <div className="flex items-center gap-2">
        <Gauge className="size-4 text-cyan-500" />
        <p className="text-sm font-semibold">Risk breakdown</p>
      </div>
      <div className="mt-4 space-y-3">
        {BREAKDOWN_LABELS.map(({ key, label }) => {
          const score = item.score_breakdown[key] ?? 0;
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

function Assessment({ item }: { item: FiatAssessment }) {
  return (
    <div className="rounded-xl border border-border/60 bg-card p-4">
      <div className="flex items-center gap-2">
        <ShieldCheck className="size-4 text-cyan-500" />
        <p className="text-sm font-semibold">Automated assessment</p>
      </div>
      <p className="mt-2 text-xs font-medium">{item.recommendation}</p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        {item.summary}
      </p>
      <div className="mt-4 space-y-2">
        {item.signals.map((signal) => (
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
              {signal.points > 0
                ? `+${signal.points}`
                : signal.points < 0
                  ? `${signal.points} risk`
                  : "Pass"}
            </Badge>
          </div>
        ))}
      </div>
    </div>
  );
}

function ReviewTrail({ detail }: { detail: FiatDetail }) {
  return (
    <div className="rounded-xl border border-border/60 bg-card p-4">
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

function ReviewStatusBadge({ status }: { status: FiatReviewStatus }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        status === "cleared" &&
          "border-emerald-500/30 text-emerald-600 dark:text-emerald-400",
        status === "in_review" &&
          "border-cyan-500/30 text-cyan-600 dark:text-cyan-400",
        status === "escalated" &&
          "border-cyan-500/30 text-cyan-600 dark:text-cyan-400",
        status === "hold_recommended" &&
          "border-rose-500/30 text-rose-600 dark:text-rose-400",
      )}
    >
      {reviewStatusLabel(status)}
    </Badge>
  );
}

function reviewStatusLabel(status: FiatReviewStatus): string {
  const labels: Record<FiatReviewStatus, string> = {
    unreviewed: "Unreviewed",
    in_review: "In review",
    cleared: "Cleared",
    escalated: "In review",
    hold_recommended: "Hold recommended",
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
        <PageHeroIdentity backHref="/antifraud/fiat-deposits" />
      </PageHero>
      <div className="rounded-xl border border-dashed border-border/70 bg-card/40 px-4 py-14 text-center">
        <CreditCard className="mx-auto mb-3 size-6 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{text}</p>
      </div>
    </div>
  );
}
