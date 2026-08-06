"use client";

import { useEffect, useId, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { Check, CircleAlert, Clock, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { StepUpField } from "@/components/step-up-field";
import { formatCurrency } from "@/lib/utils/format";
import type { CreatorRewardClaimRow } from "@/lib/creator-vip/queries";

import { HubNotice } from "../../_components/hub-notice";
import {
  approveCreatorRewardClaim,
  bulkApproveCreatorRewardClaims,
  reinstateCreatorRewardClaim,
  rejectCreatorRewardClaim,
  resendClaimDecisionNotice,
  testBotWebhookConnection,
} from "../actions";

/**
 * Verifies the approve/decline DM path end to end without messaging a player.
 * Lives next to the review queue because that is where the consequence of a
 * broken webhook shows up.
 */
export function WebhookTestButton() {
  const [isPending, startTransition] = useTransition();

  function test() {
    startTransition(async () => {
      const res = await testBotWebhookConnection();
      if (!res.success) {
        toast.error(res.error, { duration: 10_000 });
        return;
      }
      toast.success(res.data.message);
    });
  }

  return (
    <Button size="sm" variant="outline" onClick={test} disabled={isPending}>
      <Send className="size-3.5" />
      {isPending ? "Testing…" : "Test bot connection"}
    </Button>
  );
}

/**
 * Retry the decision DM after a delivery failure.
 *
 * Safe to press repeatedly: the bot dedupes on an event id derived from the
 * claim and the decision, so a press after a delivery that actually succeeded
 * returns `duplicate` and sends no second DM.
 */
export function ResendNoticeButton({ claim }: { claim: CreatorRewardClaimRow }) {
  const [isPending, startTransition] = useTransition();

  function resend() {
    startTransition(async () => {
      const res = await resendClaimDecisionNotice({ claimId: claim.id });
      if (!res.success) {
        toast.error(res.error);
        return;
      }
      toast.success("Notification delivered");
    });
  }

  // No `title` for the delivery error: the "DM failed" flag on the same row
  // already carries it in a real tooltip, and a `title` here was unreachable by
  // keyboard and touch anyway.
  return (
    <Button size="sm" variant="outline" onClick={resend} disabled={isPending}>
      <Send className="size-3.5" />
      {isPending ? "Sending…" : "Resend DM"}
    </Button>
  );
}

/** Undo for a wrongly-rejected claim: puts it back in the review queue. */
export function ReopenDialog({
  claim,
  open,
  onOpenChange,
}: {
  claim: CreatorRewardClaimRow;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const noteId = useId();
  const [note, setNote] = useState("");
  const [isPending, startTransition] = useTransition();

  function submit() {
    startTransition(async () => {
      const res = await reinstateCreatorRewardClaim({
        claimId: claim.id,
        note: note.trim(),
      });
      if (!res.success) {
        toast.error(res.error);
        return;
      }
      toast.success("Back in the review queue");
      setNote("");
      onOpenChange(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reopen this claim</DialogTitle>
          <DialogDescription>
            Puts it back in the queue for {formatCurrency(claim.amountUsd)} and
            re-reserves the {formatCurrency(claim.consumedWagerUsd)} of wager it
            was based on. Nothing is paid until someone approves it.
          </DialogDescription>
        </DialogHeader>

        {claim.reviewNote && (
          <HubNotice tone="muted">
            Rejected because: &ldquo;{claim.reviewNote}&rdquo;
          </HubNotice>
        )}

        <div className="space-y-1.5">
          <Label className="text-xs" htmlFor={noteId}>
            Why reopen it? (required)
          </Label>
          <Textarea
            id={noteId}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder="e.g. rejected by mistake — wrong row"
            disabled={isPending}
          />
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button onClick={submit} disabled={isPending || note.trim().length < 3}>
            {isPending ? "Reopening…" : "Reopen"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ApproveDialog({
  claim,
  open,
  onOpenChange,
}: {
  claim: CreatorRewardClaimRow;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [totp, setTotp] = useState("");
  const [isPending, startTransition] = useTransition();

  function submit() {
    startTransition(async () => {
      const res = await approveCreatorRewardClaim({
        claimId: claim.id,
        totpCode: totp.trim(),
      });
      if (!res.success) {
        toast.error(res.error);
        return;
      }
      toast.success(`Paid ${formatCurrency(claim.amountUsd)}`);
      setTotp("");
      onOpenChange(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Approve and pay</DialogTitle>
          <DialogDescription>
            Credits{" "}
            <strong className="text-rose-600 dark:text-rose-400">
              {formatCurrency(claim.amountUsd)}
            </strong>{" "}
            to {claim.username ?? claim.userId} and permanently consumes{" "}
            {formatCurrency(claim.consumedWagerUsd)} of their wager under{" "}
            {claim.programName}.
          </DialogDescription>
        </DialogHeader>

        {claim.switchedAway === true && (
          <HubNotice tone="amber">
            This player has since switched to another creator&apos;s code. They
            earned this before leaving, so it&apos;s still payable — but they
            can&apos;t claim here again unless they come back.
          </HubNotice>
        )}

        {/* Passkey OR authenticator code — `require2FA` accepts either, so the
            same field serves both. The note input was removed (owner,
            2026-07-23): approvals are already traceable through the claim, the
            audit event and the ledger row's creator metadata. */}
        <StepUpField value={totp} onChange={setTotp} disabled={isPending} />

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          {/* Non-empty is the right client-side test: a passkey proof token is
              far longer than 6 chars, and the server validates the real shape. */}
          <Button onClick={submit} disabled={isPending || totp.trim().length === 0}>
            {isPending ? "Paying…" : "Approve and pay"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Per-claim state inside a bulk pass. `waiting` = never attempted yet. */
type BulkClaimState =
  | { kind: "waiting" }
  | { kind: "ok" }
  | { kind: "failed"; error: string };

/**
 * Approve a selection of pending claims.
 *
 * ── WHY THIS SOMETIMES ASKS TWICE ─────────────────────────────────────────
 * `require2FA` is single-use: a TOTP code claims its step, a passkey proof
 * burns its nonce. One code therefore authorises exactly ONE payment, and the
 * server refuses to pretend otherwise (see `bulkApproveCreatorRewardClaims`).
 * The one reusable credential is the admin/owner passkey GRACE window, and the
 * shared `StepUpField` already emits it — so verifying with a passkey clears
 * the whole selection in a single pass, while a typed code steps through them
 * one at a time. The dialog says which mode it is in before anything is paid.
 *
 * Nothing is ever swallowed: every claim shows paid, failed with the server's
 * exact words, or still waiting. A claim that was never attempted is untouched.
 */
export function BulkApproveDialog({
  claims,
  open,
  onOpenChange,
  onApproved,
}: {
  /** The selected PENDING claims, in queue order. */
  claims: CreatorRewardClaimRow[];
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Ids that are now paid, so the caller can drop them from its selection. */
  onApproved: (claimIds: string[]) => void;
}) {
  const [totp, setTotp] = useState("");
  const [states, setStates] = useState<Record<string, BulkClaimState>>({});
  // Frozen at open. The list has to keep showing what happened to every claim
  // in the batch, including the ones already paid — and those leave the live
  // `claims` prop the moment approval revalidates the queue.
  const [batch, setBatch] = useState<CreatorRewardClaimRow[]>([]);
  const [isPending, startTransition] = useTransition();

  // Reopening after a partial pass must not show the previous run's verdicts
  // against a different selection.
  useEffect(() => {
    if (!open) return;
    setStates({});
    setTotp("");
    setBatch(claims);
    // Deliberately keyed on `open` alone — a mid-pass change to the live
    // selection must not swap the batch under a running approval.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const pendingIds = useMemo(
    () => batch.filter((c) => (states[c.id]?.kind ?? "waiting") === "waiting").map((c) => c.id),
    [batch, states],
  );
  const paidCount = Object.values(states).filter((s) => s.kind === "ok").length;
  const failedCount = Object.values(states).filter((s) => s.kind === "failed").length;
  const started = paidCount + failedCount > 0;

  const remainingTotal = useMemo(
    () =>
      batch
        .filter((c) => pendingIds.includes(c.id))
        .reduce((sum, c) => sum + c.amountUsd, 0),
    [batch, pendingIds],
  );

  function submit() {
    const credential = totp.trim();
    if (credential.length === 0 || pendingIds.length === 0) return;
    startTransition(async () => {
      const res = await bulkApproveCreatorRewardClaims({
        claimIds: pendingIds,
        totpCode: credential,
      });
      if (!res.success) {
        toast.error(res.error);
        return;
      }

      const next: Record<string, BulkClaimState> = {};
      for (const r of res.data.results) {
        next[r.claimId] = r.ok
          ? { kind: "ok" }
          : { kind: "failed", error: r.error ?? "Approval failed" };
      }
      setStates((prev) => ({ ...prev, ...next }));
      onApproved(res.data.results.filter((r) => r.ok).map((r) => r.claimId));

      // Clear the field so `StepUpField` re-arms: with an active passkey grace
      // it silently re-fills itself, otherwise it asks for a fresh code — which
      // is exactly the difference the server enforces.
      setTotp("");

      const okNow = res.data.results.filter((r) => r.ok).length;
      const failedNow = res.data.results.length - okNow;
      if (res.data.remaining.length === 0 && failedNow === 0) {
        toast.success(
          `Approved ${okNow} claim${okNow === 1 ? "" : "s"}`,
        );
        onOpenChange(false);
        return;
      }
      if (failedNow > 0) {
        toast.error(
          `${failedNow} claim${failedNow === 1 ? "" : "s"} couldn't be approved — see the list.`,
        );
      }
    });
  }

  const allDone = pendingIds.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Approve {batch.length} claim{batch.length === 1 ? "" : "s"}
          </DialogTitle>
          <DialogDescription>
            Pays{" "}
            <strong className="text-rose-600 dark:text-rose-400">
              {formatCurrency(remainingTotal)}
            </strong>{" "}
            across {pendingIds.length} remaining claim
            {pendingIds.length === 1 ? "" : "s"}, one at a time, through the same
            audited path as a single approval.
          </DialogDescription>
        </DialogHeader>

        {/* Said BEFORE anything is paid, because it changes how many times the
            operator will be asked. */}
        {!allDone && (
          <HubNotice tone="muted">
            A 2FA code authorises exactly one payment. Verify with a passkey to
            clear the whole selection in one go; with a typed code this approves
            one claim per code.
          </HubNotice>
        )}

        <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border p-2">
          {batch.map((c) => {
            const state = states[c.id] ?? { kind: "waiting" };
            return (
              <div
                key={c.id}
                className="flex items-start justify-between gap-3 rounded px-1.5 py-1 text-xs"
              >
                <span className="min-w-0 flex-1 truncate">
                  {c.username ?? c.userId}
                  <span className="text-muted-foreground"> · {c.programName}</span>
                </span>
                <span className="shrink-0 tabular-nums text-rose-600 dark:text-rose-400">
                  {formatCurrency(c.amountUsd)}
                </span>
                <span className="flex w-40 shrink-0 items-start gap-1">
                  {state.kind === "ok" ? (
                    // Deliberately NOT emerald: it sits inches from a rose
                    // payout figure, and emerald on this screen means "money
                    // the house took". This marks progress, not a gain.
                    <span className="flex items-center gap-1 font-medium text-foreground">
                      <Check className="size-3.5 shrink-0" aria-hidden />
                      Paid
                    </span>
                  ) : state.kind === "failed" ? (
                    <span className="flex items-start gap-1 text-rose-600 dark:text-rose-400">
                      <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
                      <span className="break-words">{state.error}</span>
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-muted-foreground">
                      <Clock className="size-3.5 shrink-0" aria-hidden />
                      Waiting
                    </span>
                  )}
                </span>
              </div>
            );
          })}
        </div>

        {started && (
          <p className="text-xs text-muted-foreground">
            {paidCount} paid · {failedCount} failed · {pendingIds.length} still
            waiting. Anything still waiting has not been touched.
          </p>
        )}

        {!allDone && (
          <StepUpField value={totp} onChange={setTotp} disabled={isPending} />
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            {allDone ? "Close" : started ? "Stop here" : "Cancel"}
          </Button>
          {!allDone && (
            <Button
              onClick={submit}
              disabled={isPending || totp.trim().length === 0}
            >
              {isPending
                ? "Paying…"
                : started
                  ? `Continue (${pendingIds.length} left)`
                  : `Approve and pay ${pendingIds.length}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RejectDialog({
  claim,
  open,
  onOpenChange,
}: {
  claim: CreatorRewardClaimRow;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const noteId = useId();
  const [note, setNote] = useState("");
  const [isPending, startTransition] = useTransition();

  function submit() {
    startTransition(async () => {
      const res = await rejectCreatorRewardClaim({
        claimId: claim.id,
        note: note.trim(),
      });
      if (!res.success) {
        toast.error(res.error);
        return;
      }
      toast.success("Claim rejected — wager released");
      setNote("");
      onOpenChange(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reject claim</DialogTitle>
          <DialogDescription>
            No balance moves. The {formatCurrency(claim.consumedWagerUsd)} this
            claim reserved is released, so the user can claim it again later.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label className="text-xs" htmlFor={noteId}>
            Reason (required)
          </Label>
          <Textarea
            id={noteId}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder="Why is this being rejected?"
            disabled={isPending}
          />
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={submit}
            disabled={isPending || note.trim().length < 3}
          >
            {isPending ? "Rejecting…" : "Reject"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
