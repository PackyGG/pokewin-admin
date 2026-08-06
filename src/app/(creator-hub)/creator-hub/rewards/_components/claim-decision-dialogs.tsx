"use client";

import { useId, useState, useTransition } from "react";
import { toast } from "sonner";
import { Send } from "lucide-react";

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
