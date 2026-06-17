"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Ban } from "lucide-react";

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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ux";

import { terminateCreatorDeal } from "../../../../../(admin)/creators/backend-actions";

type Props = {
  userId: string;
  dealId: string;
};

/**
 * Creator Hub — "Terminate deal" confirmation dialog.
 *
 * Ends the creator's CURRENT ACTIVE deal via the existing
 * `terminateCreatorDeal` server action. Destructive → guarded behind an
 * explicit confirm, with an optional reason (audited) and an opt-in toggle
 * to also force-end a live stream session tied to the deal.
 */
export function TerminateDealDialog({ userId, dealId }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [forceEnd, setForceEnd] = useState(false);
  const [pending, startTransition] = useTransition();

  function onOpenChange(next: boolean) {
    if (pending) return;
    setOpen(next);
    if (next) {
      setReason("");
      setForceEnd(false);
    }
  }

  function handleConfirm() {
    startTransition(async () => {
      try {
        await terminateCreatorDeal(userId, dealId, {
          reason: reason.trim() || undefined,
          force_end_active_session: forceEnd,
        });
        toast.success("Deal terminated");
        setOpen(false);
        router.refresh();
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to terminate deal",
        );
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className="border-rose-500/30 text-rose-600 hover:bg-rose-500/10 hover:text-rose-600 dark:text-rose-400"
          />
        }
      >
        <Ban className="mr-1 size-3.5" />
        Terminate
      </DialogTrigger>

      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-rose-500/15 text-rose-600 ring-1 ring-inset ring-rose-500/30 dark:text-rose-400">
              <Ban className="size-4" />
            </span>
            Terminate active deal
          </DialogTitle>
          <DialogDescription>
            This ends the creator&apos;s current active deal. It can&apos;t be
            undone — a new deal must be created to resume.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="terminate-reason">Reason (optional)</Label>
            <Input
              id="terminate-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. creator inactive, terms renegotiated"
              disabled={pending}
              maxLength={500}
            />
          </div>

          <div className="flex items-start justify-between gap-4 rounded-md border px-3 py-2.5">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">Force-end live session</p>
              <p className="text-xs text-muted-foreground">
                Also end any active stream session tied to this deal.
              </p>
            </div>
            <Switch
              checked={forceEnd}
              onCheckedChange={setForceEnd}
              disabled={pending}
            />
          </div>
        </div>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={pending} />}>
            Cancel
          </DialogClose>
          <Button
            type="button"
            variant="destructive"
            onClick={handleConfirm}
            disabled={pending}
            className="gap-1.5"
          >
            {pending ? <Spinner size={14} /> : <Ban className="size-4" />}
            {pending ? "Terminating…" : "Terminate deal"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
