"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  MapPin,
  RotateCcw,
  ShieldBan,
  Users,
} from "lucide-react";
import { toast } from "sonner";

import {
  createRefundBatch,
  processNextRefund,
  recoverAllRefundedAccounts,
  type RefundBatchProgress,
} from "./refund-actions";
import type {
  RefundBatchSummary,
  RefundCandidate,
} from "@/lib/queries/whop-refunds";
import { StepUpField } from "@/components/step-up-field";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

type RefundSelection =
  | { mode: "all" }
  | { mode: "users"; ids: string[] }
  | { mode: "payments"; ids: string[] };

function money(cents: number, currency: string) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}

function accountLocation(candidate: RefundCandidate): string {
  const parts = [candidate.city, candidate.state, candidate.country]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
  const location = [...new Set(parts)].join(", ");
  const countryCode = candidate.countryCode?.trim().toUpperCase();

  if (location && countryCode) return `${location} (${countryCode})`;
  return location || countryCode || "Location unknown";
}

export function RefundsPanel({
  candidates,
  recentBatches,
}: {
  candidates: RefundCandidate[];
  recentBatches: RefundBatchSummary[];
}) {
  const [payments, setPayments] = useState<Set<string>>(new Set());
  const [users, setUsers] = useState<Set<string>>(new Set());
  const [selection, setSelection] = useState<RefundSelection | null>(null);
  const [credential, setCredential] = useState("");
  const [working, setWorking] = useState(false);
  const [progress, setProgress] = useState<RefundBatchProgress | null>(null);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [recoveryCredential, setRecoveryCredential] = useState("");

  const grouped = useMemo(() => {
    const groups = new Map<string, RefundCandidate[]>();
    for (const candidate of candidates) {
      const current = groups.get(candidate.userId) ?? [];
      current.push(candidate);
      groups.set(candidate.userId, current);
    }
    return [...groups.entries()];
  }, [candidates]);

  function toggle(
    setter: (next: Set<string>) => void,
    source: Set<string>,
    id: string,
  ) {
    const next = new Set(source);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setter(next);
  }

  function open(selectionValue: RefundSelection) {
    setSelection(selectionValue);
    setCredential("");
  }

  async function runBatch(batchId: string, initial?: RefundBatchProgress) {
    setWorking(true);
    let current = initial ?? null;
    try {
      do {
        const result = await processNextRefund(batchId);
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        current = result.data;
        setProgress(current);
      } while (!current.done);
      if ((current.recoveryFailedAccounts ?? 0) > 0) {
        toast.warning(
          `Refunds finished, but ${current.recoveryFailedAccounts} account recoveries need a retry with “Ban & recover all successful refunds”.`,
          { duration: 12_000 },
        );
      } else if ((current.recoveryAuditFailures ?? 0) > 0) {
        toast.warning(
          "Refunds and account recovery finished, but an audit record could not be saved.",
          { duration: 12_000 },
        );
      } else if (current.failed + current.unknown + current.notRefundable > 0) {
        toast.warning("Refund batch finished with items that need review.");
      } else {
        toast.success("Refund batch completed.");
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Refund processing stopped.",
      );
    } finally {
      setWorking(false);
    }
  }

  async function submit() {
    if (!selection || working) return;
    setWorking(true);
    try {
      const result = await createRefundBatch({
        selection,
        credential,
      });
      if (!result.success) {
        toast.error(result.error);
        setWorking(false);
        return;
      }
      const created = result.data;
      setProgress(created);
      setSelection(null);
      setPayments(new Set());
      setUsers(new Set());
      await runBatch(created.batchId, created);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not create refund batch.",
      );
      setWorking(false);
    }
  }

  async function recoverBatch() {
    if (!recoveryOpen || !recoveryCredential || working) return;
    setWorking(true);
    try {
      const result = await recoverAllRefundedAccounts({
        credential: recoveryCredential,
      });
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      const recovery = result.data;
      const recovered = new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
      }).format(recovery.recoveredTotalUsd);
      if (!recovery.complete || recovery.auditFailures > 0) {
        toast.warning(
          `Processed ${recovery.accounts} of ${recovery.attemptedAccounts} accounts and recovered ${recovered}. ${
            recovery.failedAccounts > 0
              ? `${recovery.failedAccounts} account recovery failed; run this again to retry.`
              : `${recovery.auditFailures} audit record failed; the account changes still completed.`
          }`,
          { duration: 12_000 },
        );
      } else {
        toast.success(
          `Banned ${recovery.newlyBanned} account${
            recovery.newlyBanned === 1 ? "" : "s"
          }; recovered ${recovered}.`,
        );
        setRecoveryOpen(false);
        setRecoveryCredential("");
      }
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not recover the refunded accounts.",
      );
    } finally {
      setWorking(false);
    }
  }

  const selectableCount = candidates.filter(
    (item) => !item.alreadyQueued,
  ).length;

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-destructive/25 bg-destructive/5 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-3xl space-y-1">
            <h2 className="flex items-center gap-2 font-semibold">
              <AlertTriangle className="size-4 text-destructive" />
              Whop refunds for currently flagged accounts
            </h2>
            <p className="text-sm text-muted-foreground">
              Every payment is checked live with Whop before its full refund.
              Webhooks update the game ledger after Whop accepts it.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={users.size === 0 || working}
              onClick={() => open({ mode: "users", ids: [...users] })}
            >
              Refund selected users ({users.size})
            </Button>
            <Button
              variant="outline"
              disabled={payments.size === 0 || working}
              onClick={() => open({ mode: "payments", ids: [...payments] })}
            >
              Refund selected deposits ({payments.size})
            </Button>
            <Button
              variant="destructive"
              disabled={selectableCount === 0 || working}
              onClick={() => open({ mode: "all" })}
            >
              Refund all flagged
            </Button>
          </div>
        </div>
      </div>

      {progress && (
        <div className="rounded-lg border p-4 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium">
              Batch {progress.batchId.slice(0, 8)}
            </span>
            <Badge variant={progress.done ? "secondary" : "outline"}>
              {progress.done ? "Finished" : "Processing"}
            </Badge>
          </div>
          <p className="mt-2 text-muted-foreground">
            {progress.succeeded} refunded · {progress.alreadyRefunded} already
            refunded · {progress.pending + progress.processing} left ·{" "}
            {progress.failed + progress.unknown + progress.notRefundable} need
            review
          </p>
        </div>
      )}

      {grouped.length === 0 ? (
        <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
          No refundable Whop deposits were found for currently flagged accounts.
        </div>
      ) : (
        <div className="space-y-4">
          {grouped.map(([userId, deposits]) => {
            const first = deposits[0];
            const available = deposits.filter(
              (deposit) => !deposit.alreadyQueued,
            );
            const selectedUser = users.has(userId);
            return (
              <section
                key={userId}
                className="overflow-hidden rounded-xl border"
              >
                <div className="flex flex-wrap items-start justify-between gap-3 bg-muted/35 p-4">
                  <div className="flex items-start gap-3">
                    <Checkbox
                      aria-label={`Select user ${first?.username ?? userId}`}
                      checked={selectedUser}
                      disabled={available.length === 0}
                      onCheckedChange={() => toggle(setUsers, users, userId)}
                    />
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">
                          {first?.username || "Unknown username"}
                        </span>
                        {first?.kycRequired && (
                          <Badge variant="destructive">KYC required</Badge>
                        )}
                        <Badge variant="destructive">Flagged</Badge>
                      </div>
                      <p className="mt-1 break-all text-xs text-muted-foreground">
                        {userId}
                        {first?.email ? ` · ${first.email}` : ""}
                      </p>
                      {first && (
                        <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                          <MapPin className="size-3 shrink-0" />
                          {accountLocation(first)}
                        </p>
                      )}
                      <p className="mt-1 text-xs text-destructive">
                        {first?.flagReason}
                      </p>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={available.length === 0 || working}
                    onClick={() => open({ mode: "users", ids: [userId] })}
                  >
                    <Users className="size-4" />
                    Refund all for user
                  </Button>
                </div>
                <div className="divide-y">
                  {deposits.map((deposit) => {
                    const selected = payments.has(deposit.providerPaymentId);
                    return (
                      <div
                        key={deposit.providerPaymentId}
                        className="grid gap-3 p-4 sm:grid-cols-[auto_1fr_auto_auto] sm:items-center"
                      >
                        <Checkbox
                          aria-label={`Select payment ${deposit.providerPaymentId}`}
                          checked={selected}
                          disabled={deposit.alreadyQueued}
                          onCheckedChange={() =>
                            toggle(
                              setPayments,
                              payments,
                              deposit.providerPaymentId,
                            )
                          }
                        />
                        <div className="min-w-0">
                          <p className="truncate font-mono text-xs">
                            {deposit.providerPaymentId}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {new Date(deposit.createdAt).toLocaleString()} ·{" "}
                            {deposit.status}
                          </p>
                        </div>
                        <span className="font-semibold">
                          {money(deposit.amountCents, deposit.currency)}
                        </span>
                        {deposit.alreadyQueued ? (
                          <Badge variant="secondary">Already queued</Badge>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={working}
                            onClick={() =>
                              open({
                                mode: "payments",
                                ids: [deposit.providerPaymentId],
                              })
                            }
                          >
                            Refund
                          </Button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {recentBatches.length > 0 && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-semibold">Recent refund batches</h2>
            {recentBatches.some((batch) => batch.succeeded > 0) && (
              <Button
                size="sm"
                variant="destructive"
                disabled={working}
                onClick={() => {
                  setRecoveryOpen(true);
                  setRecoveryCredential("");
                }}
              >
                <ShieldBan className="size-4" />
                Ban &amp; recover all successful refunds
              </Button>
            )}
          </div>
          <div className="divide-y rounded-xl border">
            {recentBatches.map((batch) => (
              <div
                key={batch.batchId}
                className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm"
              >
                <div>
                  <p className="font-medium">
                    {batch.batchId.slice(0, 8)} · {batch.requestedCount}{" "}
                    payments
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(batch.createdAt).toLocaleString()}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge
                    variant={batch.issues > 0 ? "destructive" : "secondary"}
                  >
                    {batch.succeeded} done · {batch.issues} issues
                  </Badge>
                  {batch.pending > 0 && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={working}
                      onClick={() => runBatch(batch.batchId)}
                    >
                      <RotateCcw className="size-4" />
                      Resume
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <AlertDialog
        open={selection !== null}
        onOpenChange={(openValue) => {
          if (!openValue && !working) setSelection(null);
        }}
      >
        <AlertDialogContent className="sm:max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Confirm irreversible Whop refunds
            </AlertDialogTitle>
            <AlertDialogDescription>
              This creates full refunds for the selected currently flagged
              accounts. The operation cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div>
            <StepUpField
              id="refund-2fa"
              value={credential}
              onChange={setCredential}
              disabled={working}
              label="Owner verification"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={working}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={working || !credential}
              onClick={submit}
            >
              {working ? "Starting…" : "Start full refunds"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={recoveryOpen}
        onOpenChange={(openValue) => {
          if (!openValue && !working) setRecoveryOpen(false);
        }}
      >
        <AlertDialogContent className="sm:max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Ban and recover refunded accounts
            </AlertDialogTitle>
            <AlertDialogDescription>
              This bans every Packy account across all successful refunds and
              removes remaining cash, vouchers, and removable inventory only up
              to that account&apos;s refunded site credit. Completed withdrawals
              are recorded as unavailable and are not charged again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div>
            <StepUpField
              id="refund-recovery-2fa"
              value={recoveryCredential}
              onChange={setRecoveryCredential}
              disabled={working}
              label="Owner verification"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={working}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={working || !recoveryCredential}
              onClick={recoverBatch}
            >
              {working ? "Recovering…" : "Ban & recover"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
