"use client";

/**
 * Sumsub KYC — admin control card. The backend owns the state machine; this
 * card reads the current status and drives the two admin transitions:
 *   - Require KYC  → opens a new verification cycle, re-locks withdrawals.
 *   - Review       → mark the CURRENT cycle `safe` (lifts the gate) or
 *                    `rejected` (keeps it locked). Only offered while a
 *                    requirement is awaiting review (kycRequired + pending).
 *
 * `data === null` means the backend read failed (endpoint isn't deployed yet,
 * or the request errored) — render a muted "awaiting backend deploy" state
 * rather than crashing the Account tab, same convention as FraudLocksCard.
 */

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { AlertTriangle, BadgeCheck } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { requireKycAction, reviewKycAction } from "./kyc-actions";
import type {
  UserKycStatus,
  KycAdminDecision,
  KycStatus,
} from "@/lib/backend-api/kyc";

// House-POV coloring: a cleared/approved user is emerald; a required/rejected
// user (locked out) is rose; in-between provider states are amber/neutral.
function decisionBadgeClass(decision: KycAdminDecision): string {
  switch (decision) {
    case "safe":
      return "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400";
    case "rejected":
      return "bg-rose-500/15 text-rose-600 dark:text-rose-400";
    default:
      return "bg-amber-500/15 text-amber-600 dark:text-amber-400";
  }
}

function statusBadgeClass(status: KycStatus): string {
  switch (status) {
    case "approved":
      return "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400";
    case "rejected":
      return "bg-rose-500/15 text-rose-600 dark:text-rose-400";
    case "on_hold":
    case "pending":
      return "bg-amber-500/15 text-amber-600 dark:text-amber-400";
    default:
      return "bg-muted text-muted-foreground";
  }
}

export function KycCard({
  userId,
  data,
  canManage,
}: {
  userId: string;
  data: UserKycStatus | null;
  canManage: boolean;
}) {
  const [isPending, startTransition] = useTransition();
  const [requireOpen, setRequireOpen] = useState(false);
  const [localData, setLocalData] = useState<UserKycStatus | null>(data);

  // Re-sync to the prop whenever a fresh value streams in — but never while a
  // mutation is mid-flight (the action's return value is authoritative then).
  useEffect(() => {
    if (isPending) return;
    setLocalData(data);
  }, [data, isPending]);

  if (!localData) {
    return (
      <Card className="border-dashed">
        <CardContent className="pt-6">
          <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="size-4 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-medium">Backend not updated yet</p>
              <p className="text-amber-600/80 dark:text-amber-400/80">
                The KYC endpoints aren&apos;t reachable on the current backend
                deploy.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  const awaitingReview =
    localData.kycRequired && localData.adminDecision === "pending";

  const handleReview = (decision: "safe" | "rejected") => {
    startTransition(async () => {
      const result = await reviewKycAction({
        userId,
        decision,
        expectedCycle: localData.verificationCycle,
      });
      if (result.success) {
        setLocalData(result.data);
        toast.success(
          decision === "safe"
            ? "Marked safe — withdrawals re-enabled"
            : "Marked rejected — user stays locked",
        );
      } else {
        toast.error(result.error);
      }
    });
  };

  return (
    <Card>
      <CardContent className="pt-6 space-y-4">
        {/* Status row */}
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant="outline"
            className={
              localData.kycRequired
                ? "bg-rose-500/15 text-rose-600 dark:text-rose-400"
                : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
            }
          >
            {localData.kycRequired ? "KYC required" : "Not required"}
          </Badge>
          <Badge
            variant="outline"
            className={decisionBadgeClass(localData.adminDecision)}
          >
            decision: {localData.adminDecision}
          </Badge>
          <Badge
            variant="outline"
            className={statusBadgeClass(localData.status)}
          >
            provider: {localData.status}
          </Badge>
          {localData.reviewAnswer && (
            <Badge
              variant="outline"
              className={
                localData.reviewAnswer === "GREEN"
                  ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                  : "bg-rose-500/15 text-rose-600 dark:text-rose-400"
              }
            >
              {localData.reviewAnswer}
            </Badge>
          )}
          <Badge variant="outline" className="text-muted-foreground">
            cycle {localData.verificationCycle}
          </Badge>
        </div>

        {/* Detail grid */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 text-xs">
          <div className="rounded-md border bg-muted/30 px-2.5 py-1.5 space-y-0.5">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Sumsub applicant
            </div>
            <div className="font-medium break-all">
              {localData.applicantId ?? "not created yet"}
            </div>
          </div>
          <div className="rounded-md border bg-muted/30 px-2.5 py-1.5 space-y-0.5">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Moderation comment
            </div>
            <div className="font-medium">
              {localData.moderationComment ?? "—"}
            </div>
          </div>
        </div>

        {canManage && (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={isPending}
              onClick={() => setRequireOpen(true)}
            >
              <BadgeCheck className="mr-1 h-3 w-3" />
              {localData.kycRequired ? "Re-require KYC" : "Require KYC"}
            </Button>
            {awaitingReview && (
              <>
                <Button
                  size="sm"
                  disabled={isPending}
                  onClick={() => handleReview("safe")}
                >
                  {isPending ? "Working…" : "Mark safe"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={isPending}
                  onClick={() => handleReview("rejected")}
                >
                  {isPending ? "Working…" : "Reject"}
                </Button>
              </>
            )}
          </div>
        )}

        <RequireKycDialog
          userId={userId}
          open={requireOpen}
          onOpenChange={setRequireOpen}
          onDone={setLocalData}
        />
      </CardContent>
    </Card>
  );
}

function RequireKycDialog({
  userId,
  open,
  onOpenChange,
  onDone,
}: {
  userId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: (next: UserKycStatus) => void;
}) {
  const [reason, setReason] = useState("");
  const [levelName, setLevelName] = useState("");
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (open) {
      setReason("");
      setLevelName("");
    }
  }, [open]);

  const handleSubmit = () => {
    const trimmed = reason.trim();
    if (trimmed.length < 3) {
      toast.error("Reason must be at least 3 characters");
      return;
    }
    startTransition(async () => {
      const result = await requireKycAction({
        userId,
        reason: trimmed,
        levelName: levelName.trim() || undefined,
      });
      if (result.success) {
        onDone(result.data);
        toast.success("KYC required — user must verify before withdrawing");
        onOpenChange(false);
      } else {
        toast.error(result.error);
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Require KYC</DialogTitle>
          <DialogDescription>
            Opens a new verification cycle and re-locks this user&apos;s
            withdrawals until an admin marks the cycle safe. The user is
            prompted to verify through Sumsub on their next withdrawal attempt.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="kyc-reason" className="text-xs">
              Reason (internal / audit)
            </Label>
            <Textarea
              id="kyc-reason"
              rows={3}
              maxLength={500}
              placeholder="Why this user is being asked to verify"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="kyc-level" className="text-xs">
              Sumsub level name (optional)
            </Label>
            <Input
              id="kyc-level"
              placeholder="Leave blank to use the backend default"
              value={levelName}
              onChange={(e) => setLevelName(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button size="sm" onClick={handleSubmit} disabled={isPending}>
            {isPending ? "Requiring…" : "Require KYC"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
