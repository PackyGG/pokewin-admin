"use client";

import { useEffect, useState, useTransition } from "react";
import { CheckCircle2, Crown, Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ux";

import {
  loadCreatorCodesForApproval,
  submitCreatorDealApproval,
} from "./deal-approval-actions";
import {
  buildRewardDraft,
  CreatorRewardDraftFields,
  parseRewardDraft,
  type CreatorRewardDraft,
} from "./creator-reward-draft-fields";

/**
 * Creator Hub — "New Rewards Program" (Discord approval, no deal).
 *
 * Same fields as the reward step of the deal wizard, plus its own window,
 * because there is no deal to inherit one from. Goes straight to Approve /
 * Decline in the creator's Discord channel with no terms step.
 */
export function NewRewardsProgramDialog({ userId }: { userId: string }) {
  const [open, setOpen] = useState(false);
  const [availableCodes, setAvailableCodes] = useState<string[]>([]);
  const [draft, setDraft] = useState<CreatorRewardDraft>(() =>
    buildRewardDraft([]),
  );
  const [queued, setQueued] = useState<{
    requestId: string;
    status: string;
    deliveryQueued: boolean;
  } | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void loadCreatorCodesForApproval(userId)
      .then((codes) => {
        if (cancelled) return;
        setAvailableCodes(codes);
        setDraft(buildRewardDraft(codes));
      })
      .catch(() => {
        if (!cancelled) toast.error("Could not load this creator's codes");
      });
    return () => {
      cancelled = true;
    };
  }, [open, userId]);

  function onOpenChange(next: boolean) {
    if (pending) return;
    setOpen(next);
    if (next) {
      setAvailableCodes([]);
      setDraft(buildRewardDraft([]));
      setQueued(null);
    }
  }

  function submit() {
    const parsed = parseRewardDraft(draft, { requireWindow: true });
    if ("error" in parsed) {
      toast.error(parsed.error);
      return;
    }
    startTransition(async () => {
      const result = await submitCreatorDealApproval({
        creatorUserId: userId,
        dealPayload: null,
        rewardPayload: parsed.payload,
        leaderboardPayload: null,
      });
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      setQueued(result);
      toast.success("Reward program sent for approval");
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        <Plus className="mr-1 size-3.5" />
        New Rewards Program
      </DialogTrigger>

      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-pink-500/15 text-pink-600 ring-1 ring-inset ring-pink-500/30 dark:text-pink-400">
              <Crown className="size-4" />
            </span>
            {queued ? "Sent for creator approval" : "Reward program for approval"}
          </DialogTitle>
          <DialogDescription>
            {queued
              ? "The creator channel will receive the program with Approve and Decline."
              : "Nothing is created yet. The program starts accruing only once it is approved in Discord."}
          </DialogDescription>
        </DialogHeader>

        {queued ? (
          <div className="space-y-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4">
            <div className="flex items-center gap-2 font-medium text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 className="size-5" />
              Approval request saved
            </div>
            <p className="text-sm text-muted-foreground">
              {queued.deliveryQueued
                ? "Discord delivery is queued. No reward accrues until the creator approves."
                : "The request is saved, but Discord delivery was not queued. Its delivery state is retained for retry."}
            </p>
            <p className="font-mono text-xs text-muted-foreground">
              {queued.requestId} · {queued.status}
            </p>
          </div>
        ) : (
          <CreatorRewardDraftFields
            availableCodes={availableCodes}
            draft={draft}
            onChange={setDraft}
            disabled={pending}
            showWindow
          />
        )}

        <DialogFooter>
          {queued ? (
            <DialogClose render={<Button />}>Done</DialogClose>
          ) : (
            <>
              <DialogClose render={<Button variant="outline" disabled={pending} />}>
                Cancel
              </DialogClose>
              <Button
                type="button"
                onClick={submit}
                disabled={pending || availableCodes.length === 0}
                className="gap-1.5"
              >
                {pending && <Spinner size={14} />}
                {pending ? "Queueing…" : "Send to Discord"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
