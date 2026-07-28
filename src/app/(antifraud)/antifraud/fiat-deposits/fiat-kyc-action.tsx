"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { BadgeCheck } from "lucide-react";
import { toast } from "sonner";

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
import { requireFiatDepositKyc } from "./actions";

export function FiatKycAction({
  depositIntentId,
  userId,
  accountLabel,
  currentlyRequired,
}: {
  depositIntentId: string;
  userId: string;
  accountLabel: string;
  currentlyRequired: boolean;
}) {
  const router = useRouter();
  const [required, setRequired] = useState(currentlyRequired);
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const isRequired = required || currentlyRequired;

  if (isRequired) {
    return (
      <Button size="sm" variant="outline" disabled>
        <BadgeCheck className="size-3.5" />
        KYC required
      </Button>
    );
  }

  function requireKyc(): void {
    startTransition(async () => {
      try {
        const result = await requireFiatDepositKyc({
          depositIntentId,
          userId,
        });
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        setRequired(true);
        setOpen(false);
        if (result.alreadyRequired) {
          toast.success("KYC was already required for this account.");
        } else if (result.readbackConfirmed) {
          toast.success("KYC is now required and withdrawals are locked.");
        } else {
          toast.warning(
            "KYC was required, but the live status is still refreshing.",
          );
        }
        router.refresh();
      } catch {
        toast.error("KYC could not be required. Refresh and try again.");
      }
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger
        render={
          <Button size="sm" variant="outline" disabled={isPending} />
        }
      >
        <BadgeCheck className="size-3.5" />
        Require KYC
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Require KYC for {accountLabel}?</AlertDialogTitle>
          <AlertDialogDescription>
            This immediately starts a KYC cycle and locks withdrawals until an
            owner or admin reviews it. A Sumsub result never unlocks the
            account automatically.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={isPending}
            onClick={(event) => {
              event.preventDefault();
              requireKyc();
            }}
          >
            {isPending ? "Applying…" : "Require KYC"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
