"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ux";
import { updateChallenge } from "./actions";
import type { ChallengeStatus } from "@/lib/backend-api";

type Props = {
  challengeId: string;
  name: string;
  prizeAmount: number;
  maxClaims: number;
  claimedCount: number;
  status: ChallengeStatus;
  version: number;
};

export function EditChallengeButton({
  challengeId,
  name,
  prizeAmount,
  maxClaims,
  claimedCount,
  status,
  version,
}: Props) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const [prize, setPrize] = useState(prizeAmount.toString());
  const [claims, setClaims] = useState(maxClaims.toString());
  const [nextStatus, setNextStatus] = useState<ChallengeStatus>(status);

  function resetForm() {
    setPrize(prizeAmount.toString());
    setClaims(maxClaims.toString());
    setNextStatus(status);
  }

  function handleSubmit() {
    const prizeNum = parseFloat(prize);
    if (!Number.isFinite(prizeNum) || prizeNum <= 0) {
      toast.error("Prize must be greater than 0");
      return;
    }
    const claimsNum = parseInt(claims, 10);
    if (!Number.isFinite(claimsNum) || claimsNum < 1) {
      toast.error("Max claims must be at least 1");
      return;
    }
    // max_claims cannot drop below the number already claimed.
    if (claimsNum < claimedCount) {
      toast.error(`Max claims can't be below already-claimed count (${claimedCount})`);
      return;
    }

    startTransition(async () => {
      try {
        const result = await updateChallenge(challengeId, {
          expectedVersion: version,
          prizeAmount: prizeNum,
          maxClaims: claimsNum,
          status: nextStatus,
        });
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        toast.success("Challenge updated");
        setOpen(false);
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to update challenge");
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v) resetForm();
      }}
    >
      <DialogTrigger render={<Button variant="ghost" size="sm" />}>
        <Pencil className="mr-1 size-3" /> Edit
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit Challenge</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Editing <span className="font-medium text-foreground">{name}</span>. Only
            prize, claim cap, and status can change — the challenge criteria and type
            are immutable.
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Prize Amount (USD)</Label>
              <Input
                type="number"
                value={prize}
                onChange={(e) => setPrize(e.target.value)}
                min={0}
                step="0.01"
              />
            </div>
            <div className="space-y-2">
              <Label>Max Claims</Label>
              <Input
                type="number"
                value={claims}
                onChange={(e) => setClaims(e.target.value)}
                min={Math.max(1, claimedCount)}
                step={1}
              />
              {claimedCount > 0 && (
                <p className="text-[11px] text-muted-foreground">
                  {claimedCount} already claimed — cap can&apos;t go below this.
                </p>
              )}
            </div>
          </div>
          <div className="space-y-2">
            <Label>Status</Label>
            <Select
              value={nextStatus}
              onValueChange={(v) => v && setNextStatus(v as ChallengeStatus)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="inactive">Inactive</SelectItem>
                <SelectItem value="archived">Archived</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={handleSubmit} disabled={isPending} className="w-full sm:w-auto">
            {isPending && <Spinner size={15} className="text-current" />}
            {isPending ? "Saving..." : "Save Changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
