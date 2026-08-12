"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { BadgeCheck, Ban, Clock3, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { clientActionError } from "@/lib/errors/client-action-error";

import { StepUpField } from "@/components/step-up-field";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
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
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ANTIFRAUD_BAN_REASON_PRESETS } from "@/lib/ban-reasons";
import { cn } from "@/lib/utils";
import {
  postponeReview,
  requireReviewKyc,
  runQuickReviewAccountAction,
  type QuickReviewAccountAction,
} from "../actions";
import { useReviewCaseDismissal } from "./review-case-dialog";

const ACTIONS: Array<{
  action: QuickReviewAccountAction;
  label: string;
  title: string;
  description: (account: string) => string;
  confirm: string;
  success: string;
  icon: typeof ShieldCheck;
  variant: "destructive" | "secondary";
}> = [
  {
    action: "fine",
    label: "Approve",
    title: "Approve this account?",
    description: (account) =>
      `${account} will be cleared from Account Review and every automatic review lock will be removed.`,
    confirm: "Yes, approve account",
    success: "Account approved and review locks removed",
    icon: ShieldCheck,
    variant: "secondary",
  },
  {
    action: "ban",
    label: "Ban",
    title: "Ban this account?",
    description: (account) =>
      `${account} will be banned immediately and all active sessions will be revoked.`,
    confirm: "Yes, ban account",
    success: "Account banned",
    icon: Ban,
    variant: "destructive",
  },
];

type ReviewActionLock = { current: boolean };

export function QuickReviewActions({
  reviewId,
  targetUserId,
  targetUsername,
  status,
  compact = false,
}: {
  reviewId: string;
  targetUserId: string;
  targetUsername: string | null;
  status: string;
  compact?: boolean;
}) {
  const dismissal = useReviewCaseDismissal();
  const terminal = status === "cleared" || status === "flagged";
  const actionLock = useRef(false);
  const [actionPending, setActionPending] = useState(false);

  useEffect(() => {
    if (!dismissal || terminal) return;
    return dismissal.registerDismissHandler(() =>
      postponeReview({
        reviewId,
        expectedStatus: status,
        idempotencyKey: crypto.randomUUID(),
      }).then((result) => {
        if (!result.success) throw new Error(result.error);
      }),
    );
  }, [dismissal, reviewId, status, terminal]);

  if (terminal) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {ACTIONS.map((item) => (
        <QuickActionButton
          key={item.action}
          {...item}
          reviewId={reviewId}
          account={targetUsername ?? targetUserId}
          status={status}
          compact={compact}
          actionLock={actionLock}
          actionPending={actionPending}
          setActionPending={setActionPending}
          onActionCompleted={dismissal?.completeAction}
        />
      ))}
      <RequireKycButton
        reviewId={reviewId}
        account={targetUsername ?? targetUserId}
        compact={compact}
        actionLock={actionLock}
        actionPending={actionPending}
        setActionPending={setActionPending}
        onActionCompleted={dismissal?.completeAction}
      />
      <PostponeButton
        reviewId={reviewId}
        status={status}
        compact={compact}
        actionLock={actionLock}
        actionPending={actionPending}
        setActionPending={setActionPending}
        onActionCompleted={dismissal?.completeAction}
      />
    </div>
  );
}

function PostponeButton({
  reviewId,
  status,
  compact,
  actionLock,
  actionPending,
  setActionPending,
  onActionCompleted,
}: {
  reviewId: string;
  status: string;
  compact: boolean;
  actionLock: ReviewActionLock;
  actionPending: boolean;
  setActionPending: (pending: boolean) => void;
  onActionCompleted?: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const idempotencyKey = useRef<string | null>(null);

  function handlePostpone() {
    if (actionLock.current) return;
    actionLock.current = true;
    setActionPending(true);
    startTransition(async () => {
      try {
        idempotencyKey.current ??= crypto.randomUUID();
        const result = await postponeReview({
          reviewId,
          expectedStatus: status,
          idempotencyKey: idempotencyKey.current,
        });
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        onActionCompleted?.();
        toast.success("Review postponed for 2 hours");
        if (!onActionCompleted) router.refresh();
      } catch (error) {
        toast.error(
          clientActionError(error, "The action failed"),
        );
      } finally {
        actionLock.current = false;
        setActionPending(false);
      }
    });
  }

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={pending || actionPending}
      onClick={handlePostpone}
      className={cn(
        "border-orange-500/40 bg-orange-500/10 text-orange-700 hover:bg-orange-500/20 hover:text-orange-800 dark:text-orange-300 dark:hover:text-orange-200",
        compact && "h-8 px-2.5 text-xs",
      )}
    >
      <Clock3 className="mr-1.5 size-3.5" />
      {pending ? "Postponing…" : "Postpone"}
    </Button>
  );
}

/**
 * Additive, not a verdict: unlike Approve/Ban this never touches the case
 * status, so it stays available on any live case regardless of who owns it.
 * Delegates entirely to the canonical `requireReviewKyc` action, which is
 * gated the same as the KYC workspace (owner/admin, fresh 2FA, and the
 * account must already have withdrawals locked) — this dialog just collects
 * the same inputs the workspace does.
 */
function RequireKycButton({
  reviewId,
  account,
  compact,
  actionLock,
  actionPending,
  setActionPending,
  onActionCompleted,
}: {
  reviewId: string;
  account: string;
  compact: boolean;
  actionLock: ReviewActionLock;
  actionPending: boolean;
  setActionPending: (pending: boolean) => void;
  onActionCompleted?: () => void;
}) {
  const router = useRouter();
  const reasonId = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [credential, setCredential] = useState("");
  const [pending, startTransition] = useTransition();
  const idempotencyKey = useRef<string | null>(null);

  function reset() {
    setReason("");
    setCredential("");
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (actionLock.current) return;
    actionLock.current = true;
    setActionPending(true);
    startTransition(async () => {
      try {
        idempotencyKey.current ??= crypto.randomUUID();
        const result = await requireReviewKyc({
          reviewId,
          reason,
          credential,
          idempotencyKey: idempotencyKey.current,
        });
        if (!result.ok) {
          toast.error(result.error);
          return;
        }
        setOpen(false);
        reset();
        onActionCompleted?.();
        toast.success(`${account} now requires KYC`);
        if (!onActionCompleted) router.refresh();
      } catch (error) {
        toast.error(
          clientActionError(error, "The action failed"),
        );
      } finally {
        actionLock.current = false;
        setActionPending(false);
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next && !pending) reset();
      }}
    >
      <DialogTrigger
        render={
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending || actionPending}
            className={cn(compact && "h-8 px-2.5 text-xs")}
          />
        }
      >
        <BadgeCheck className="mr-1.5 size-3.5" />
        Require KYC
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Require KYC on this account?</DialogTitle>
            <DialogDescription>
              {account} keeps its current case status — this only opens a new
              KYC cycle. Available only while balance and item withdrawals are
              already locked.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-1.5">
              <Label htmlFor={reasonId}>Internal reason</Label>
              <Textarea
                id={reasonId}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                rows={3}
                minLength={4}
                maxLength={500}
                placeholder="Why this account must verify"
                required
              />
            </div>
            <StepUpField
              value={credential}
              onChange={setCredential}
              disabled={pending}
              label="Fresh TOTP or passkey"
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={pending || !credential || reason.trim().length < 4}
            >
              {pending ? "Requiring…" : "Require KYC"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function QuickActionButton({
  action,
  label,
  title,
  description,
  confirm,
  success,
  icon: Icon,
  variant,
  reviewId,
  account,
  status,
  compact,
  actionLock,
  actionPending,
  setActionPending,
  onActionCompleted,
}: (typeof ACTIONS)[number] & {
  reviewId: string;
  account: string;
  status: string;
  compact: boolean;
  actionLock: ReviewActionLock;
  actionPending: boolean;
  setActionPending: (pending: boolean) => void;
  onActionCompleted?: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [credential, setCredential] = useState("");
  const [reasonOption, setReasonOption] = useState("");
  const [customReason, setCustomReason] = useState("");
  const idempotencyKey = useRef<string | null>(null);
  const sensitive = action === "ban";
  const effectiveReason =
    reasonOption === "custom" ? customReason.trim() : reasonOption;

  function handleConfirm() {
    if (actionLock.current) return;
    actionLock.current = true;
    setActionPending(true);
    startTransition(async () => {
      try {
        idempotencyKey.current ??= crypto.randomUUID();
        const result = await runQuickReviewAccountAction({
          reviewId,
          action,
          expectedStatus: status,
          idempotencyKey: idempotencyKey.current,
          credential: sensitive ? credential : undefined,
          banReason: sensitive ? effectiveReason : undefined,
        });
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        const outcome = result.data;
        setCredential("");
        setReasonOption("");
        setCustomReason("");
        onActionCompleted?.();
        if (outcome.withdrawalRelease === "failed") {
          toast.warning(
            "Account approved, but one or more review locks could not be removed. Check the user profile.",
          );
        } else if (outcome.withdrawalRelease === "kyc_gated") {
          toast.warning(
            "Account approved. KYC-controlled locks stay active until KYC is approved.",
          );
        } else {
          toast.success(
            outcome.withdrawalRelease === "released"
              ? "Account approved — review locks removed"
              : success,
          );
        }
        if (!onActionCompleted) router.refresh();
      } catch (error) {
        toast.error(
          clientActionError(error, "The action failed"),
        );
      } finally {
        actionLock.current = false;
        setActionPending(false);
      }
    });
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={
          <Button
            type="button"
            size="sm"
            variant={variant}
            disabled={pending || actionPending}
            className={cn(
              action === "fine" &&
                "border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700 dark:border-emerald-500 dark:bg-emerald-600 dark:hover:bg-emerald-500",
              compact && "h-8 px-2.5 text-xs",
            )}
          />
        }
      >
        <Icon className="mr-1.5 size-3.5" />
        {pending ? "Working…" : label}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>
            {description(account)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {sensitive && (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Ban reason</Label>
              <Select
                value={reasonOption || undefined}
                onValueChange={(value) => setReasonOption(value ?? "")}
                disabled={pending}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select why this account is being banned" />
                </SelectTrigger>
                <SelectContent>
                  {ANTIFRAUD_BAN_REASON_PRESETS.map((reason) => (
                    <SelectItem key={reason} value={reason}>
                      {reason}
                    </SelectItem>
                  ))}
                  <SelectItem value="custom">Custom reason</SelectItem>
                </SelectContent>
              </Select>
              {reasonOption === "custom" && (
                <Input
                  value={customReason}
                  onChange={(event) => setCustomReason(event.target.value)}
                  minLength={4}
                  maxLength={500}
                  placeholder="Write the exact reason"
                  autoFocus
                  disabled={pending}
                />
              )}
              <p className="text-xs text-muted-foreground">
                A shared IP or device alone is not proof. Legitimate established
                accounts with normal deposits, play, and withdrawals can be approved.
              </p>
            </div>
            <StepUpField
              value={credential}
              onChange={setCredential}
              disabled={pending}
              label="Fresh TOTP or passkey"
            />
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={
              pending ||
              (sensitive && (!credential || effectiveReason.length < 4))
            }
          >
            {confirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
