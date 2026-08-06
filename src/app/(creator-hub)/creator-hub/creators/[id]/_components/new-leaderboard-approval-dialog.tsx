"use client";

import { useEffect, useState, useTransition } from "react";
import { CheckCircle2, Trophy } from "lucide-react";
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
  buildLeaderboardDraft,
  CreatorLeaderboardDraftFields,
  parseLeaderboardDraft,
  type CreatorLeaderboardDraft,
} from "./creator-leaderboard-draft-fields";

/**
 * Creator Hub — "New Leaderboard (needs approval)".
 *
 * The Discord-approval counterpart to `CreateLeaderboardDialog`, which stays
 * the instant-create path. Nothing is created here: the board is stored as an
 * immutable proposal and only provisioned once the creator (or a linked site
 * admin) approves it in Discord. There is no deal and no terms step — a
 * site-funded leaderboard carries no creator obligation to agree to.
 */
export function NewLeaderboardApprovalDialog({ userId }: { userId: string }) {
  const [open, setOpen] = useState(false);
  const [codesLoaded, setCodesLoaded] = useState(false);
  const [draft, setDraft] = useState<CreatorLeaderboardDraft>(() =>
    buildLeaderboardDraft([]),
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
        setDraft(buildLeaderboardDraft(codes));
        setCodesLoaded(true);
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
      setDraft(buildLeaderboardDraft([]));
      setCodesLoaded(false);
      setQueued(null);
    }
  }

  function submit() {
    const parsed = parseLeaderboardDraft(draft, { requireWindow: true });
    if ("error" in parsed) {
      toast.error(parsed.error);
      return;
    }
    startTransition(async () => {
      const result = await submitCreatorDealApproval({
        creatorUserId: userId,
        dealPayload: null,
        rewardPayload: null,
        leaderboardPayload: parsed.payload,
      });
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      setQueued(result);
      toast.success("Leaderboard sent for approval");
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        <Trophy className="mr-1 size-3.5" />
        New Leaderboard (needs approval)
      </DialogTrigger>

      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-amber-600 ring-1 ring-inset ring-amber-500/30 dark:text-amber-400">
              <Trophy className="size-4" />
            </span>
            {queued ? "Sent for creator approval" : "Leaderboard for approval"}
          </DialogTitle>
          <DialogDescription>
            {queued
              ? "The creator channel will receive the leaderboard with Approve and Decline."
              : "Nothing is created yet. Site-funded, runs on all of this creator's codes, and goes live only once it is approved in Discord."}
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
                ? "Discord delivery is queued. The leaderboard stays uncreated until the creator approves."
                : "The request is saved, but Discord delivery was not queued. Its delivery state is retained for retry."}
            </p>
            <p className="font-mono text-xs text-muted-foreground">
              {queued.requestId} · {queued.status}
            </p>
          </div>
        ) : (
          <CreatorLeaderboardDraftFields
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
                disabled={pending || !codesLoaded || draft.codes.length === 0}
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
