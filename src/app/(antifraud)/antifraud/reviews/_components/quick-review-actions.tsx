"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Ban, Clock3, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

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
import { cn } from "@/lib/utils";
import {
  postponeReview,
  runQuickReviewAccountAction,
  type QuickReviewAccountAction,
} from "../actions";

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
  if (status === "cleared" || status === "flagged") return null;

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
        />
      ))}
      <PostponeButton reviewId={reviewId} status={status} compact={compact} />
    </div>
  );
}

function PostponeButton({
  reviewId,
  status,
  compact,
}: {
  reviewId: string;
  status: string;
  compact: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const idempotencyKey = useRef<string | null>(null);

  function handlePostpone() {
    startTransition(async () => {
      try {
        idempotencyKey.current ??= crypto.randomUUID();
        await postponeReview({
          reviewId,
          expectedStatus: status,
          idempotencyKey: idempotencyKey.current,
        });
        toast.success("Review postponed for 2 hours");
        router.refresh();
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "The action failed",
        );
      }
    });
  }

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={pending}
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
}: (typeof ACTIONS)[number] & {
  reviewId: string;
  account: string;
  status: string;
  compact: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [credential, setCredential] = useState("");
  const idempotencyKey = useRef<string | null>(null);
  const sensitive = action === "ban";

  function handleConfirm() {
    startTransition(async () => {
      try {
        idempotencyKey.current ??= crypto.randomUUID();
        const result = await runQuickReviewAccountAction({
          reviewId,
          action,
          expectedStatus: status,
          idempotencyKey: idempotencyKey.current,
          credential: sensitive ? credential : undefined,
        });
        setCredential("");
        if (result.withdrawalRelease === "failed") {
          toast.warning(
            "Account approved, but one or more review locks could not be removed. Check the user profile.",
          );
        } else if (result.withdrawalRelease === "kyc_gated") {
          toast.warning(
            "Account approved. KYC-controlled locks stay active until KYC is approved.",
          );
        } else {
          toast.success(
            result.withdrawalRelease === "released"
              ? "Account approved — review locks removed"
              : success,
          );
        }
        router.refresh();
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "The action failed",
        );
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
            disabled={pending}
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
          <StepUpField
            value={credential}
            onChange={setCredential}
            disabled={pending}
            label="Fresh TOTP or passkey"
          />
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={pending || (sensitive && !credential)}
          >
            {confirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
