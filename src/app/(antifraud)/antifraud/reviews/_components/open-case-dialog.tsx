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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { REVIEW_SEVERITIES, REVIEW_SEVERITY_LABELS } from "@/lib/antifraud/constants";
import { openReview } from "../actions";

/**
 * "Open case" dialog — the manual entry point into the review queue, for when
 * an analyst spots something before the backend does.
 *
 * The player is identified by their MAIN-DB user id, which is a loose string
 * here on purpose (this workspace never reads or writes the prod game DB). The
 * username field is a convenience snapshot so the queue is readable at a glance.
 */
export function OpenCaseDialog() {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [targetUserId, setTargetUserId] = React.useState("");
  const [targetUsername, setTargetUsername] = React.useState("");
  const [severity, setSeverity] = React.useState<string>("medium");
  const [reason, setReason] = React.useState("");

  function reset() {
    setTargetUserId("");
    setTargetUsername("");
    setSeverity("medium");
    setReason("");
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    try {
      const { id } = await openReview({
        targetUserId: targetUserId.trim(),
        targetUsername: targetUsername.trim(),
        severity,
        reason: reason.trim(),
      });
      toast.success("Case opened");
      setOpen(false);
      reset();
      router.push(hrefForCurrentHost(`/antifraud/reviews/${id}`));
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
              <Label htmlFor="case-severity">Severity</Label>
              <Select
                value={severity}
                onValueChange={(v) => setSeverity(v ?? "medium")}
              >
                <SelectTrigger id="case-severity">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REVIEW_SEVERITIES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {REVIEW_SEVERITY_LABELS[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
