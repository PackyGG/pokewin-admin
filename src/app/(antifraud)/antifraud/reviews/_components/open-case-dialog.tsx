"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { hrefForCurrentHost } from "@/lib/use-app-host";
import { Textarea } from "@/components/ui/textarea";
import { openReview } from "../actions";

/**
 * "Open case" dialog — the manual entry point into the review queue, for when
 * an analyst spots something before the backend does.
 *
 * The player is identified by their MAIN-DB user id, which is a loose string
 * here on purpose (this workspace never reads or writes the prod game DB). The
 * username field is a convenience snapshot so the queue is readable at a glance.
 */
type OpenCasePrefill = {
  targetUserId?: string;
  targetUsername?: string;
  reason?: string;
  monitorCaseId?: string;
};

export function OpenCaseDialog({
  prefill = {},
  autoOpen = false,
}: {
  prefill?: OpenCasePrefill;
  autoOpen?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(autoOpen);
  const [loading, setLoading] = React.useState(false);
  const [targetUserId, setTargetUserId] = React.useState(
    prefill.targetUserId ?? "",
  );
  const [targetUsername, setTargetUsername] = React.useState(
    prefill.targetUsername ?? "",
  );
  const [reason, setReason] = React.useState(
    prefill.reason ??
      (prefill.monitorCaseId
        ? `Opened from monitor case ${prefill.monitorCaseId}.`
        : ""),
  );

  function reset() {
    setTargetUserId("");
    setTargetUsername("");
    setReason("");
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    try {
      const result = await openReview({
        targetUserId: targetUserId.trim(),
        targetUsername: targetUsername.trim(),
        reason: reason.trim(),
      });
      if (!result.ok) {
        const conflictReviewId = result.conflictReviewId;
        toast.error(
          result.message,
          conflictReviewId
            ? {
                action: {
                  label: "Open live case",
                  onClick: () =>
                    router.push(
                      hrefForCurrentHost(
                        `/antifraud/reviews?review=${encodeURIComponent(conflictReviewId)}`,
                      ),
                    ),
                },
              }
            : undefined,
        );
        return;
      }
      toast.success("Case opened");
      setOpen(false);
      reset();
      router.push(
        hrefForCurrentHost(
          `/antifraud/reviews?review=${encodeURIComponent(result.id)}`,
        ),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not open the case");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" variant="outline" />}>
        <Plus className="mr-2 size-4" />
        Open case
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Open an account review</DialogTitle>
            <DialogDescription>
              This records a case for the fraud team. It does not ban, restrict
              or otherwise change the account — do that on the main dashboard.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-1.5">
              <Label htmlFor="case-user-id">Player user id</Label>
              <Input
                id="case-user-id"
                value={targetUserId}
                onChange={(e) => setTargetUserId(e.target.value)}
                placeholder="e.g. cm2f4k9x0000abcd"
                autoComplete="off"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="case-username">Username (optional)</Label>
              <Input
                id="case-username"
                value={targetUsername}
                onChange={(e) => setTargetUsername(e.target.value)}
                placeholder="shown in the queue"
                autoComplete="off"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="case-reason">Why is this account being reviewed?</Label>
              <Textarea
                id="case-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                placeholder="What you saw, and what you want checked."
                required
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? "Opening…" : "Open case"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
