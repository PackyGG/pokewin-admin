"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
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
import { processCreatorPayout } from "../actions";
import { formatCurrency } from "@/lib/utils/format";

export function CreatorPayoutButton({
  affiliateUserId,
  availableUsd,
}: {
  affiliateUserId: string;
  availableUsd: number;
}) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function handlePayout() {
    startTransition(async () => {
      try {
        await processCreatorPayout(affiliateUserId);
        toast.success("Payout processed");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to process payout");
      }
    });
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button disabled={isPending || availableUsd <= 0} />}>
        Process Payout ({formatCurrency(availableUsd)})
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Process Creator Payout?</AlertDialogTitle>
          <AlertDialogDescription>
            This will transfer {formatCurrency(availableUsd)} to the creator&apos;s balance.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handlePayout}>Confirm Payout</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
