"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Flag, Loader2 } from "lucide-react";

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
import { Textarea } from "@/components/ui/textarea";
import type { MultiplierDealResponse } from "@/lib/backend-api";

import { flagMultiplierDeal } from "../../multiplier-actions";

type Props = {
  deal: MultiplierDealResponse;
  trigger: React.ReactNode;
  onSuccess?: () => void;
};

/**
 * Flag dialog — adds a manual reviewer-supplied flag entry to a
 * pending_review (or already flagged) deal. The backend prefixes the
 * supplied code with `MANUAL:` so audit can distinguish auto vs human.
 *
 * Use case: reviewer spots something the automated detector missed
 * (e.g. external Kick chat evidence of collusion, suspicious wager
 * pattern across multiple streams).
 *
 * No money movement here — just an audit annotation that nudges the deal
 * back into the flagged bucket.
 */
export function MultiplierFlagDialog({ deal, trigger, onSuccess }: Props) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [reason, setReason] = useState("");
  const [isPending, startTransition] = useTransition();

  const codeValid = code.trim().length > 0 && code.trim().length <= 64;
  const disabled = isPending || !codeValid;

  function reset() {
    setCode("");
    setReason("");
  }

  function submit() {
    startTransition(async () => {
      try {
        await flagMultiplierDeal(deal.user_id, deal.id, {
          code: code.trim(),
          reason: reason.trim() || undefined,
        });
        toast.success("Manual flag added");
        setOpen(false);
        reset();
        onSuccess?.();
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to flag deal",
        );
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger render={trigger as React.ReactElement} />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Flag className="size-5 text-orange-500" />
            Manually Flag Deal
          </DialogTitle>
          <DialogDescription>
            Add a manual flag entry. The code is prefixed with{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">
              MANUAL:
            </code>{" "}
            on save so audit can separate auto-detected from human-added
            flags. No money moves here — the deal stays in review for an
            approve/reject decision afterward.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="flag-code">
              Code <span className="text-rose-500">*</span>
            </Label>
            <Input
              id="flag-code"
              placeholder="e.g. SUSPECTED_COLLUSION"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              maxLength={64}
            />
            <p className="text-xs text-muted-foreground">
              Short identifier — UPPER_SNAKE_CASE preferred. Will be stored
              as <code>MANUAL:{code.trim() || "YOUR_CODE"}</code>.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="flag-reason">Reason / context</Label>
            <Textarea
              id="flag-reason"
              placeholder="External evidence, suspicious pattern observed, etc."
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              maxLength={500}
            />
          </div>
        </div>

        <DialogFooter>
          <DialogClose
            render={<Button variant="ghost" disabled={isPending} />}
          >
            Cancel
          </DialogClose>
          <Button onClick={submit} disabled={disabled}>
            {isPending ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                Flagging…
              </>
            ) : (
              <>Add flag</>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
