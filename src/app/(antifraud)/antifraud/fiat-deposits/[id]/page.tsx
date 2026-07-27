import { notFound } from "next/navigation";
import {
  Banknote,
  CheckCircle2,
  CircleAlert,
  Clock3,
  CreditCard,
  Fingerprint,
  History,
  ShieldAlert,
  ShieldCheck,
  UserRoundCheck,
  WalletCards,
} from "lucide-react";

import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { Badge } from "@/components/ui/badge";
import { getFiatAssessment } from "@/lib/antifraud/fiat-deposits-api";
import { requireAntifraudPageAccess } from "@/lib/require-antifraud-access";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils/format";
import { FiatReviewControls } from "./review-controls";

export const metadata = { title: "Fiat Deposit Review · Antifraud" };

export default async function FiatDepositReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAntifraudPageAccess();
  const { id } = await params;
  const result = await getFiatAssessment(id);
  if (result.notFound) notFound();
  if (!result.configured || result.error || !result.data) {
    return (
      <div className="space-y-6">
        <PageHero>
          <PageHeroIdentity icon={ShieldAlert} accent="cyan" title="Fiat deposit review" subtitle="Assessment unavailable" backHref="/antifraud/fiat-deposits" />
        </PageHero>
        <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
          {!result.configured ? "The Antifraud monitor is not configured." : "This assessment could not be loaded."}
        </div>
      </div>
    );
  }
  const { assessment: item, timeline, reviewEvents } = result.data;
  const style = verdictStyle(item.verdict);
  const VerdictIcon = style.icon;
  const provider = item.provider_evidence;
  const funding = item.funding_evidence;
  const behavior = item.behavior_evidence;
  const account = item.account_evidence;
  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Banknote}
          accent="cyan"
          title="Fiat deposit review"
          subtitle={`${item.username ?? item.user_id} · ${formatCurrency(item.credited_amount_usd)} via ${item.provider}`}
          backHref="/antifraud/fiat-deposits"
        />
      </PageHero>

      <div className={cn("rounded-xl border p-4", style.box)}>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-start gap-3">
            <VerdictIcon className={cn("mt-0.5 size-7 shrink-0", style.text)} />
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <p className={cn("text-lg font-semibold capitalize", style.text)}>{item.verdict} · {item.risk_score}/100</p>
                <Badge variant="outline" className="capitalize">{item.review_status.replaceAll("_", " ")}</Badge>
                <Badge variant="outline" className="capitalize">{item.status.replaceAll("_", " ")}</Badge>
              </div>
              <p className="mt-1 text-sm font-medium">{item.recommendation}</p>
              <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">{item.summary}</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 text-right sm:grid-cols-3">
            <HeaderMetric label="Credited" value={formatCurrency(item.credited_amount_usd)} />
            <HeaderMetric label="Customer paid" value={item.customer_total_usd === null ? "—" : formatCurrency(item.customer_total_usd)} />
            <HeaderMetric label="Occurred" value={formatDate(item.occurred_at)} />
          </div>
        </div>
      </div>

      <section>
        <div className="mb-3">
          <h2 className="text-sm font-semibold">Risk flow</h2>
          <p className="text-xs text-muted-foreground">Six independent checks. Open each card for the evidence behind the score.</p>
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {item.flow_checks.map((check, index) => (
            <div key={check.key} className={cn(
              "rounded-xl border p-4",
              check.status === "pass" && "border-emerald-500/25 bg-emerald-500/5",
              check.status === "review" && "border-amber-500/25 bg-amber-500/5",
              check.status === "block" && "border-rose-500/25 bg-rose-500/5",
            )}>
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold">{index + 1}. {check.label}</p>
                <Badge variant="outline" className="capitalize">{check.status} · {check.score}</Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{check.description}</p>
              <div className="mt-3 space-y-1.5">
                {check.evidence.map((evidence) => (
                  <p key={evidence} className="flex gap-2 text-xs leading-5">
                    <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                    {evidence}
                  </p>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.55fr)_minmax(330px,0.7fr)]">
        <div className="space-y-6">
          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <EvidenceCard icon={CreditCard} title="Whop & 3DS" rows={[
              ["Risk score", provider.riskScore === null ? "No result" : `${provider.riskScore}/100`],
              ["3DS", provider.threeDsVerified === true ? "Verified" : provider.threeDsVerified === false ? "Not verified" : "No result"],
              ["Disputes / refunds", `${provider.disputeCount} / ${provider.refundCount}`],
              ["Payment method", provider.paymentMethodType ?? "Not supplied"],
            ]} />
            <EvidenceCard icon={WalletCards} title="Funding history" rows={[
              ["Prior crypto", `${funding.priorCryptoDeposits} · ${formatCurrency(funding.priorCryptoUsd)}`],
              ["Prior fiat", `${funding.priorFiatDeposits} · ${formatCurrency(funding.priorFiatUsd)}`],
              ["Earlier average", formatCurrency(funding.priorDepositAverageUsd)],
              ["Size vs average", funding.currentVsAverageRatio === null ? "First deposit" : `${funding.currentVsAverageRatio.toFixed(1)}x`],
            ]} />
            <EvidenceCard icon={UserRoundCheck} title="Account trust" rows={[
              ["Account age", `${account.accountAgeDays.toFixed(1)} days`],
              ["KYC", account.kycStatus],
              ["Fiat attempts", `${account.fiatAttempts1h} / hour · ${account.fiatAttempts24h} / day`],
              ["Restrictions", account.isBanned || account.isLocked ? "Restricted" : "None"],
            ]} />
            <EvidenceCard icon={Fingerprint} title="Account links" rows={[
              ["Shared device", `${account.sharedDeviceUsers} other users`],
              ["Shared signup IP", `${account.sharedSignupIpUsers} other users`],
              ["Suspected alt", account.isSuspectedAlt ? "Yes" : "No"],
              ["Country", account.countryCode ?? provider.billingCountry ?? "Unknown"],
            ]} />
          </section>

          {provider.riskSignals.length > 0 && (
            <section className="rounded-xl border bg-card p-4">
              <div className="flex items-center gap-2">
                <ShieldCheck className="size-4 text-cyan-500" />
                <h2 className="text-sm font-semibold">Whop risk signals</h2>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">Only risk fields are shown. Card, phone, and billing identity data are not copied into Antifraud.</p>
              <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {provider.riskSignals.map((signal) => (
                  <div key={signal.key} className="rounded-lg border border-border/60 bg-muted/20 p-2.5 text-xs">
                    <p className="font-medium">{signal.label}</p>
                    <p className="mt-1 break-words text-muted-foreground">{String(signal.value ?? "No result")}</p>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="rounded-xl border bg-card p-4">
            <div className="flex items-center gap-2">
              <History className="size-4 text-cyan-500" />
              <h2 className="text-sm font-semibold">Money trail</h2>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              The latest funding before this payment, including crypto, then play, rewards, and withdrawals after it.
            </p>
            <div className="mt-4 space-y-0">
              {timeline.map((event, index) => (
                <div key={event.id} className="relative grid grid-cols-[22px_minmax(0,1fr)_auto] gap-3 pb-4">
                  {index < timeline.length - 1 && <span className="absolute left-[10px] top-5 h-full w-px bg-border" />}
                  <span className={cn(
                    "relative z-10 mt-0.5 size-[22px] rounded-full border-4 border-card",
                    event.isCurrent ? "bg-cyan-500" : event.tone === "bad" ? "bg-rose-500" : event.tone === "warning" ? "bg-amber-500" : "bg-emerald-500",
                  )} />
                  <div>
                    <p className="text-sm font-medium capitalize">{event.label}</p>
                    <p className="text-[11px] text-muted-foreground">{formatDate(event.occurredAt)}{event.detail ? ` · ${event.detail}` : ""}</p>
                  </div>
                  <span className="text-sm font-medium tabular-nums">{event.amountUsd ? formatCurrency(event.amountUsd) : "—"}</span>
                </div>
              ))}
              {timeline.length === 0 && <p className="text-xs text-muted-foreground">No linked money movement found.</p>}
            </div>
          </section>

          <section className="rounded-xl border bg-card p-4">
            <div className="flex items-center gap-2">
              <Clock3 className="size-4 text-cyan-500" />
              <h2 className="text-sm font-semibold">Post-deposit behavior</h2>
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              <Metric label="Wagered" value={formatCurrency(behavior.gameWagerUsd)} />
              <Metric label="Play-through" value={`${(behavior.playthroughRatio * 100).toFixed(0)}%`} />
              <Metric label="Withdrawals" value={`${behavior.withdrawalRequests} · ${formatCurrency(behavior.withdrawalUsd)}`} />
              <Metric label="Game payouts" value={formatCurrency(behavior.gamePayoutUsd)} />
              <Metric label="Rewards" value={formatCurrency(behavior.rewardsUsd)} />
              <Metric label="First cash-out" value={behavior.minutesToFirstWithdrawal === null ? "None" : `${behavior.minutesToFirstWithdrawal.toFixed(0)} min`} />
            </div>
          </section>
        </div>

        <aside className="space-y-4">
          <FiatReviewControls depositIntentId={item.deposit_intent_id} status={item.review_status} />
          <section className="rounded-xl border bg-card p-4">
            <h2 className="text-sm font-semibold">Triggered signals</h2>
            <div className="mt-3 space-y-3">
              {item.signals.map((signal) => (
                <div key={signal.key} className="flex items-start justify-between gap-3 text-xs">
                  <div>
                    <p className="font-medium">{signal.label}</p>
                    <p className="mt-0.5 leading-5 text-muted-foreground">{signal.detail}</p>
                  </div>
                  {signal.points > 0 ? <Badge variant="outline" className="shrink-0">+{signal.points}</Badge> : <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-500" />}
                </div>
              ))}
            </div>
          </section>
          <section className="rounded-xl border bg-card p-4">
            <h2 className="text-sm font-semibold">Review trail</h2>
            <div className="mt-3 space-y-3">
              {reviewEvents.map((event) => (
                <div key={event.id} className="border-l-2 border-cyan-500/35 pl-3 text-xs">
                  <p className="font-medium capitalize">{event.action.replaceAll("_", " ")}</p>
                  <p className="text-muted-foreground">{event.actor_username ?? event.actor_id} · {formatDate(event.created_at)}</p>
                  {event.note && <p className="mt-1 leading-5">{event.note}</p>}
                </div>
              ))}
              {reviewEvents.length === 0 && <p className="text-xs text-muted-foreground">No analyst action yet.</p>}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

function HeaderMetric({ label, value }: { label: string; value: string }) {
  return <div><p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p><p className="mt-1 text-sm font-semibold tabular-nums">{value}</p></div>;
}

function EvidenceCard({ icon: Icon, title, rows }: { icon: React.ElementType; title: string; rows: Array<[string, string]> }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-center gap-2"><Icon className="size-4 text-cyan-500" /><h2 className="text-sm font-semibold">{title}</h2></div>
      <div className="mt-3 space-y-2">
        {rows.map(([label, value]) => <div key={label} className="flex items-start justify-between gap-3 text-xs"><span className="text-muted-foreground">{label}</span><span className="text-right font-medium capitalize">{value}</span></div>)}
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-border/60 bg-muted/20 p-3"><p className="text-[10px] text-muted-foreground">{label}</p><p className="mt-1 text-sm font-semibold tabular-nums">{value}</p></div>;
}

function verdictStyle(verdict: "good" | "review" | "bad") {
  if (verdict === "good") return { icon: ShieldCheck, text: "text-emerald-500", box: "border-emerald-500/25 bg-emerald-500/5" };
  if (verdict === "bad") return { icon: ShieldAlert, text: "text-rose-500", box: "border-rose-500/25 bg-rose-500/5" };
  return { icon: CircleAlert, text: "text-amber-500", box: "border-amber-500/25 bg-amber-500/5" };
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
