"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { BadgeCheck, RotateCcw } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import { requireAccountKyc } from "../actions";

export function RequireKycDialog({
  account,
  accountLabel,
  compact = false,
}: {
  account?: string;
  accountLabel?: string;
  compact?: boolean;
}) {
  const router = useRouter();
  const accountId = useId();
  const reasonId = useId();
  const levelId = useId();
  const [open, setOpen] = useState(false);
  const [accountQuery, setAccountQuery] = useState(account ?? "");
  const [reason, setReason] = useState("");
  const [levelName, setLevelName] = useState("");
  const [isPending, startTransition] = useTransition();
  const isRerequire = Boolean(account);

  function reset(): void {
    setAccountQuery(account ?? "");
    setReason("");
    setLevelName("");
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    startTransition(async () => {
      const result = await requireAccountKyc({
        account: accountQuery,
        reason,
        levelName: levelName || undefined,
      });
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success(
        isRerequire
          ? "A new KYC cycle is now required."
          : "The account now requires KYC.",
      );
      setOpen(false);
      reset();
      router.refresh();
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next && !isPending) reset();
      }}
    >
      <DialogTrigger
        render={
          <Button
            size={compact ? "xs" : "sm"}
            variant={compact ? "outline" : "default"}
          />
        }
      >
        {isRerequire ? (
          <RotateCcw className="mr-1.5 size-3.5" />
        ) : (
          <BadgeCheck className="mr-1.5 size-4" />
        )}
        {isRerequire ? "New cycle" : "Require KYC"}
      </DialogTrigger>

      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>
              {isRerequire ? "Require a new KYC cycle" : "Require KYC"}
            </DialogTitle>
            <DialogDescription>
              This locks withdrawals until an owner or admin reviews the
              current verification cycle. Sumsub results never unlock an
              account automatically.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-1.5">
              <Label htmlFor={accountId}>Account</Label>
              <Input
                id={accountId}
                value={accountQuery}
                onChange={(event) => setAccountQuery(event.target.value)}
                placeholder="Player ID, username, display name, or email"
                readOnly={isRerequire}
                autoComplete="off"
                required
              />
              {accountLabel && (
                <p className="text-xs text-muted-foreground">{accountLabel}</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={reasonId}>Internal reason</Label>
              <Textarea
                id={reasonId}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                rows={3}
                minLength={3}
                maxLength={500}
                placeholder="Why this account must verify"
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={levelId}>Sumsub level override</Label>
              <Input
                id={levelId}
                value={levelName}
                onChange={(event) => setLevelName(event.target.value)}
                maxLength={100}
                placeholder="Blank uses the backend default"
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                Only set this when the account needs a different configured
                Sumsub flow.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Applying…" : "Require verification"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
