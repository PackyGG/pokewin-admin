"use client";

import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CircleCheck,
  Link2,
  ShieldAlert,
  UserRound,
  WalletCards,
} from "lucide-react";

import { HostLink } from "@/components/host-link";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { WithdrawalAssessment } from "@/lib/antifraud/withdrawals-api";
import { hrefForCurrentHost } from "@/lib/use-app-host";
import { cn } from "@/lib/utils";
import { formatCurrency, formatDateTime } from "@/lib/utils/format";
import { WithdrawalReviewControls } from "./[id]/review-controls";

export function WithdrawalReviewDialog({
  withdrawal,
  closeHref,
}: {
  withdrawal: WithdrawalAssessment;
  closeHref: string;
}) {
  const router = useRouter();
  const trace = withdrawal.flow.fundingTrace;
  const riskyAccounts = withdrawal.flow.linkedAccounts.filter(hasRisk);

  function close() {
    router.replace(hrefForCurrentHost(closeHref), { scroll: false });
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="sm:h-[min(92vh,60rem)] sm:max-h-[92vh] sm:w-[min(64rem,calc(100%-2rem))] sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>
            Withdrawal review · {formatCurrency(withdrawal.amount_usd)}
          </DialogTitle>
          <DialogDescription>
            {withdrawal.username ?? withdrawal.user_id} ·{" "}
            {formatDateTime(withdrawal.requested_at)}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-3">
          <ReviewFact
            label="Ledger coverage"
            value={`${formatCurrency(trace.coveredUsd)} / ${formatCurrency(trace.requestedUsd)}`}
            alert={!trace.complete}
          />
          <ReviewFact
            label="Funding entries"
            value={`${trace.entries.length} allocated`}
            alert={trace.entries.length === 0}
          />
          <ReviewFact
            label="Linked account risk"
            value={
              riskyAccounts.length > 0
                ? `${riskyAccounts.length} flagged`
                : `${withdrawal.flow.linkedAccounts.length} checked`
            }
            alert={riskyAccounts.length > 0}
          />
        </div>

        <section className="space-y-2">
          <div className="flex items-center gap-2">
            <WalletCards className="size-4 text-cyan-500" />
            <h3 className="text-sm font-semibold">
              Allocated funding for this withdrawal
            </h3>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            Completed ledger credits are allocated backwards through later
            spending until the requested amount is covered. Account balance is
            fungible, so this is an accounting trace rather than coin-level
            proof.
          </p>
          <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
            {trace.entries.length > 0 ? (
              trace.entries.map((entry) => (
                <div
                  key={entry.id}
                  className="flex items-start justify-between gap-3 rounded-lg border bg-card p-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{entry.label}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatDateTime(entry.occurredAt)}
                      {entry.counterpartyReason
                        ? ` · ${entry.counterpartyReason}`
                        : ""}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-sm font-semibold tabular-nums">
                      {formatCurrency(entry.allocatedUsd)}
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      of {formatCurrency(entry.grossCreditUsd)}
                    </p>
                  </div>
                </div>
              ))
            ) : (
              <div className="rounded-lg border border-dashed p-4 text-xs text-muted-foreground">
                No completed ledger credit could be allocated.
              </div>
            )}
          </div>
        </section>

        <section className="space-y-2">
          <div className="flex items-center gap-2">
            <Link2 className="size-4 text-cyan-500" />
            <h3 className="text-sm font-semibold">Linked funding accounts</h3>
          </div>
          {withdrawal.flow.linkedAccounts.length > 0 ? (
            <div className="space-y-2">
              {withdrawal.flow.linkedAccounts.map((account) => {
                const flags = accountFlags(account);
                const risky = hasRisk(account);
                return (
                  <div
                    key={account.userId}
                    className={cn(
                      "rounded-lg border p-3",
                      risky
                        ? "border-rose-500/30 bg-rose-500/5"
                        : "border-emerald-500/20 bg-emerald-500/5",
                    )}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <HostLink
                            href={`/users/${account.userId}`}
                            className="truncate text-sm font-semibold hover:underline"
                          >
                            {account.username ?? account.email ?? account.userId}
                          </HostLink>
                          <UserRound className="size-3.5 text-muted-foreground" />
                        </div>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {account.reasons.join(", ")}
                        </p>
                      </div>
                      <p className="shrink-0 text-sm font-semibold tabular-nums">
                        {formatCurrency(account.attributedUsd)}
                      </p>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {flags.length > 0 ? (
                        flags.map((flag) => (
                          <Badge
                            key={flag}
                            variant="outline"
                            className="border-rose-500/30 text-rose-600 dark:text-rose-400"
                          >
                            {flag}
                          </Badge>
                        ))
                      ) : (
                        <Badge
                          variant="outline"
                          className="border-emerald-500/30 text-emerald-600 dark:text-emerald-400"
                        >
                          No restriction found
                        </Badge>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed p-4 text-xs text-muted-foreground">
              No other player account was linked to the allocated credits.
            </div>
          )}
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Automated checks</h3>
          <div className="grid gap-2 sm:grid-cols-2">
            {withdrawal.flow_checks.map((check) => {
              const alert =
                check.status === "watch" || check.status === "alert";
              const Icon = alert
                ? check.status === "alert"
                  ? ShieldAlert
                  : AlertTriangle
                : CircleCheck;
              return (
                <div
                  key={check.key}
                  className={cn(
                    "rounded-lg border p-3",
                    alert && "border-amber-500/30 bg-amber-500/5",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <Icon
                      className={cn(
                        "size-4",
                        alert ? "text-amber-500" : "text-emerald-500",
                      )}
                    />
                    <p className="text-sm font-medium">{check.label}</p>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {check.evidence[0]}
                  </p>
                </div>
              );
            })}
          </div>
        </section>

        <WithdrawalReviewControls
          withdrawalId={withdrawal.withdrawal_id}
          status={withdrawal.review_status}
        />
      </DialogContent>
    </Dialog>
  );
}

function ReviewFact({
  label,
  value,
  alert,
}: {
  label: string;
  value: string;
  alert: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border p-3",
        alert && "border-rose-500/30 bg-rose-500/5",
      )}
    >
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-semibold">{value}</p>
    </div>
  );
}

type LinkedAccount =
  WithdrawalAssessment["flow"]["linkedAccounts"][number];

function hasRisk(account: LinkedAccount): boolean {
  return (
    account.isLocked ||
    account.isBanned ||
    account.isSuspectedAlt ||
    account.isSelfExcluded ||
    account.withdrawalsLocked ||
    account.kycRequired ||
    account.kycStatus === "rejected" ||
    account.kycDecision === "rejected" ||
    account.activeFraudCase ||
    account.adminReviewStatus === "open" ||
    account.adminReviewStatus === "in_review" ||
    account.adminReviewStatus === "flagged" ||
    account.adminTags.includes("wager_abuser")
  );
}

function accountFlags(account: LinkedAccount): string[] {
  const flags: string[] = [];
  if (account.isLocked) flags.push("Account locked");
  if (account.isBanned) flags.push("Banned");
  if (account.isSuspectedAlt) flags.push("Suspected alt");
  if (account.isSelfExcluded) flags.push("Self-excluded");
  if (account.withdrawalsLocked) flags.push("Withdrawals locked");
  if (account.kycRequired) flags.push(`KYC ${account.kycStatus}`);
  if (account.kycStatus === "rejected" || account.kycDecision === "rejected") {
    flags.push("KYC rejected");
  }
  if (account.activeFraudCase) flags.push(`Active fraud case · ${account.fraudScore}`);
  if (account.adminReviewStatus) {
    flags.push(`Review ${account.adminReviewStatus.replaceAll("_", " ")}`);
  }
  flags.push(...account.adminTags.map((tag) => `Tag: ${tag.replaceAll("_", " ")}`));
  return [...new Set(flags)];
}
