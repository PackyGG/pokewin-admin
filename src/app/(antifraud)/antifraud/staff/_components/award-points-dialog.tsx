"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { awardPointsManually } from "../actions";

/**
 * Owner/admin points adjustment. Negative amounts are allowed and are how a
 * mistake gets corrected — the ledger is append-only, so a correction is a
 * compensating event rather than an edit.
 */
export function AwardPointsDialog({
  members,
}: {
  members: { id: string; label: string; points: number }[];
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [adminUserId, setAdminUserId] = React.useState("");
  const [points, setPoints] = React.useState(1);
  const [reason, setReason] = React.useState("");

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    try {
      await awardPointsManually({
        adminUserId,
        points,
        reason: reason.trim(),
      });
      toast.success(points > 0 ? "Points awarded" : "Points deducted");
      setOpen(false);
      setAdminUserId("");
      setPoints(1);
      setReason("");
      router.refresh();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not adjust points",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" variant="outline" />}>
        <Sparkles className="mr-2 size-4" />
        Adjust points
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Adjust staff points</DialogTitle>
            <DialogDescription>
              Recorded as its own ledger entry with your name on it. Use a
              negative amount to correct a mistake — nothing is ever edited away.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-1.5">
              <Label htmlFor="award-member">Staff member</Label>
              <Select
                value={adminUserId}
                onValueChange={(v) => setAdminUserId(v ?? "")}
              >
                <SelectTrigger id="award-member">
                  <SelectValue placeholder="Pick someone…" />
                </SelectTrigger>
                <SelectContent>
                  {members.map((member) => (
                    <SelectItem key={member.id} value={member.id}>
                      <span className="font-medium">{member.label}</span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        {member.points} pts
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="award-points">Points</Label>
              <Input
                id="award-points"
                type="number"
                value={points}
                onChange={(e) => setPoints(Number(e.target.value))}
                required
              />
              <p className="text-[10px] text-muted-foreground">
                Negative deducts. Max 500 either way.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="award-reason">Reason</Label>
              <Input
                id="award-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Shown to them in their activity feed"
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
            <Button type="submit" disabled={loading || !adminUserId}>
              {loading ? "Saving…" : "Apply"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
