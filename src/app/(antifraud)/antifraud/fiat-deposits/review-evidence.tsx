import { AlertTriangle, CheckCircle2, ShieldAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { FiatAssessment } from "@/lib/antifraud/fiat-deposits-api";
import { cn } from "@/lib/utils";

function scoreClass(score: number): string {
  if (score >= 70) {
    return "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300";
  }
  if (score >= 50) {
    return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
  return "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300";
}

function evidenceGaps(assessment: FiatAssessment): string[] {
  const evidence = assessment.detection_evidence;
  const gaps: string[] = [];
  if (
    evidence.paymentIdentityHistoryStatus === "partial" ||
    evidence.paymentIdentityHistoryStatus === "unavailable"
  ) {
    gaps.push("payment identity history");
  }
  if (evidence.authorizedNetworkHistoryStatus === "unavailable") {
    gaps.push("IP/device history");
  }
  if (evidence.payerEmailStatus === "unavailable") {
    gaps.push("payer email");
  }
  if (evidence.threeDsStatus === "unavailable") gaps.push("3DS result");
  return gaps;
}

function compactFacts(assessment: FiatAssessment): string[] {
  const detection = assessment.detection_evidence;
  const facts: string[] = [];
  if (detection.checkoutEmailDiffersFromAccount) {
    facts.push("Checkout email differs from account email");
  }
  if (detection.billingCountryMismatch) {
    facts.push("Billing country differs from account country");
  }
  if (detection.checkoutEmailSharedUsers > 1) {
    facts.push(`Checkout email shared by ${detection.checkoutEmailSharedUsers} accounts`);
  }
  if (detection.whopCustomerSharedUsers > 1) {
    facts.push(`Whop customer shared by ${detection.whopCustomerSharedUsers} accounts`);
  }
  if (detection.paymentMethodSharedUsers > 1) {
    facts.push(`Payment method shared by ${detection.paymentMethodSharedUsers} accounts`);
  }
  if (detection.cardSignatureSharedUsers > 1) {
    facts.push(`Card signature shared by ${detection.cardSignatureSharedUsers} accounts`);
  }
  if (detection.checkoutDeviceSharedUsers > 1) {
    facts.push(`Checkout device shared by ${detection.checkoutDeviceSharedUsers} accounts`);
  }
  if (detection.checkoutIpSharedUsers > 1) {
    facts.push(`Checkout IP shared by ${detection.checkoutIpSharedUsers} accounts`);
  }
  if (detection.exactAmountDistinctUsers30m > 1) {
    facts.push(
      `Same amount attempted ${detection.exactAmountAttempts30m} times by ${detection.exactAmountDistinctUsers30m} accounts in 30 minutes`,
    );
  }
  if (detection.exactAmountRefunded7d > 0) {
    facts.push(
      `${detection.exactAmountRefunded7d} same-amount deposits were refunded in 7 days`,
    );
  }
  return facts;
}

export function FiatReviewEvidence({
  assessment,
  safeguards,
}: {
  assessment: FiatAssessment;
  safeguards?: {
    fiatDepositsLocked: boolean;
    withdrawalsLocked: boolean;
  };
}) {
  const drivers = [...assessment.signals]
    .filter((signal) => signal.points > 0)
    .sort((left, right) => right.points - left.points);
  const trust = assessment.signals.filter((signal) => signal.points < 0);
  const gaps = evidenceGaps(assessment);
  const facts = compactFacts(assessment);
  const topDrivers = drivers.slice(0, 3);
  const provider = assessment.provider_evidence;
  const activeSafeguards = [
    assessment.account_evidence.isBanned ? "Account banned" : null,
    assessment.account_evidence.isLocked ? "Account locked" : null,
    assessment.account_evidence.kycRequired ? "KYC required" : null,
    safeguards?.fiatDepositsLocked ? "Fiat deposits locked" : null,
    safeguards?.withdrawalsLocked ? "Withdrawals locked" : null,
  ].filter((item): item is string => item !== null);
  return (
    <div className="min-w-0 space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline" className={cn("font-semibold tabular-nums", scoreClass(assessment.risk_score))}>
          Risk {assessment.risk_score}/100
        </Badge>
        <Badge
          variant="outline"
          className={
            assessment.verdict === "bad"
              ? "border-rose-500/30 text-rose-700 dark:text-rose-300"
              : assessment.verdict === "review"
                ? "border-amber-500/30 text-amber-700 dark:text-amber-300"
                : "border-emerald-500/30 text-emerald-700 dark:text-emerald-300"
          }
        >
          {assessment.verdict === "bad" ? "High concern" : assessment.verdict}
        </Badge>
        {provider.threeDsVerified === true && (
          <Badge variant="outline" className="border-emerald-500/30 text-emerald-700 dark:text-emerald-300">
            3DS verified
          </Badge>
        )}
        {provider.threeDsVerified === false && (
          <Badge variant="outline" className="border-rose-500/30 text-rose-700 dark:text-rose-300">
            3DS failed
          </Badge>
        )}
      </div>

      <p className="text-xs font-medium leading-5">{assessment.recommendation}</p>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs font-medium">Current safeguards:</span>
        {activeSafeguards.length > 0 ? activeSafeguards.map((safeguard) => (
          <Badge
            key={safeguard}
            variant="outline"
            className="border-rose-500/30 text-rose-700 dark:text-rose-300"
          >
            {safeguard}
          </Badge>
        )) : (
          <span className="text-xs text-muted-foreground">
            None reported
          </span>
        )}
      </div>

      {topDrivers.length > 0 ? (
        <div className="space-y-1">
          {topDrivers.map((signal) => (
            <div key={signal.key} className="flex items-start justify-between gap-2 text-xs">
              <span className="min-w-0 text-muted-foreground" title={signal.detail}>
                {signal.label}
              </span>
              <span className="shrink-0 font-semibold tabular-nums text-amber-700 dark:text-amber-300">
                +{signal.points}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-300">
          <CheckCircle2 className="size-3.5" />
          No positive score driver returned
        </div>
      )}

      {gaps.length > 0 && (
        <div className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>Evidence incomplete: {gaps.join(", ")}</span>
        </div>
      )}

      <details className="rounded-md border border-border/60 px-2.5 py-2 text-xs">
        <summary className="cursor-pointer font-medium">All risk evidence</summary>
        <div className="mt-2 space-y-3 border-t border-border/60 pt-2">
          <div className="grid gap-1 sm:grid-cols-2">
            <span className="text-muted-foreground">
              Checkout email: {provider.checkoutEmail ?? "Unavailable"}
            </span>
            <span className="text-muted-foreground">
              Card: {provider.cardBrand?.toUpperCase() ?? "Unknown"} {provider.cardLast4 ? `•••• ${provider.cardLast4}` : "ending unavailable"}
            </span>
            <span className="text-muted-foreground">
              Provider risk: {provider.riskScore ?? "Unavailable"}
            </span>
            <span className="text-muted-foreground">
              Prior Fiat: {assessment.funding_evidence.priorFiatDeposits} deposits / ${assessment.funding_evidence.priorFiatUsd.toFixed(2)}
            </span>
          </div>

          <div>
            <p className="mb-1 font-semibold">Score breakdown</p>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(assessment.score_breakdown).map(([category, points]) => (
                <Badge key={category} variant="outline" className="tabular-nums">
                  {category}: {points > 0 ? "+" : ""}{points}
                </Badge>
              ))}
            </div>
          </div>

          {assessment.flow_checks.some((check) => check.status !== "pass" || check.score !== 0) && (
            <div>
              <p className="mb-1 font-semibold">Assessment checks</p>
              <div className="space-y-1.5">
                {assessment.flow_checks
                  .filter((check) => check.status !== "pass" || check.score !== 0)
                  .map((check) => (
                    <div key={check.key} className="rounded-md border border-border/60 p-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">{check.label}</span>
                        <Badge variant="outline">{check.status}</Badge>
                      </div>
                      <p className="mt-1 text-muted-foreground">{check.description}</p>
                      {check.evidence.length > 0 && (
                        <ul className="mt-1 space-y-0.5 text-muted-foreground">
                          {check.evidence.map((item) => <li key={item}>• {item}</li>)}
                        </ul>
                      )}
                    </div>
                  ))}
              </div>
            </div>
          )}

          {facts.length > 0 && (
            <div>
              <p className="mb-1 font-semibold">Identity and platform-wide clusters</p>
              <ul className="space-y-1 text-muted-foreground">
                {facts.map((fact) => <li key={fact}>• {fact}</li>)}
              </ul>
            </div>
          )}

          <div>
            <p className="mb-1 font-semibold">Every scored trigger</p>
            {drivers.length + trust.length === 0 ? (
              <p className="text-muted-foreground">No scored trigger returned.</p>
            ) : (
              <div className="space-y-1.5">
                {[...drivers, ...trust].map((signal) => (
                  <div key={signal.key} className="flex items-start justify-between gap-3">
                    <span className="text-muted-foreground">
                      <span className="font-medium text-foreground">{signal.label}</span>
                      {` — ${signal.detail}`}
                    </span>
                    <span className={cn(
                      "shrink-0 font-semibold tabular-nums",
                      signal.points > 0
                        ? "text-amber-700 dark:text-amber-300"
                        : "text-emerald-700 dark:text-emerald-300",
                    )}>
                      {signal.points > 0 ? "+" : ""}{signal.points}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-start gap-1.5 rounded-md border border-border/60 p-2 text-muted-foreground">
            <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>
              Approve credits only this payment. Decline does not refund it; it locks Fiat deposits and withdrawals and sends the payment to Admin Deposits.
            </span>
          </div>
        </div>
      </details>
    </div>
  );
}
