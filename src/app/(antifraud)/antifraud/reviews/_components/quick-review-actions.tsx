"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Ban, LockKeyhole, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
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
import {
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
  variant: "outline" | "destructive" | "secondary";
}> = [
  {
    action: "fine",
    label: "Fine",
    title: "Mark this account fine?",
    description: (account) =>
      `${account} will be cleared from Account Review. This changes only the case verdict.`,
    confirm: "Yes, mark fine",
    success: "Account marked fine",
    icon: ShieldCheck,
    variant: "outline",
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
  {
    action: "lock_withdrawals",
    label: "Lock withdrawals",
    title: "Lock all withdrawals?",
    description: (account) =>
      `${account} will be blocked from crypto and item withdrawals. The review stays open.`,
    confirm: "Yes, lock withdrawals",
    success: "Withdrawals locked",
    icon: LockKeyhole,
    variant: "secondary",
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
    <div className="flex flex-wrap gap-1.5">
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
    </div>
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

  function handleConfirm() {
    startTransition(async () => {
      try {
        await runQuickReviewAccountAction({
          reviewId,
          action,
          expectedStatus: status,
          idempotencyKey: crypto.randomUUID(),
        });
        toast.success(success);
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
            className={compact ? "h-7 px-2 text-[11px]" : undefined}
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
            {description(account)} One confirmation is required. There is no
            separate 2FA prompt.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleConfirm} disabled={pending}>
            {confirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
