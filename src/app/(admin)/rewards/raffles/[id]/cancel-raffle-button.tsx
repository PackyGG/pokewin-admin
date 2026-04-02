"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cancelRaffle } from "../actions";

export function CancelRaffleButton({ raffleId }: { raffleId: string }) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function handleCancel() {
    if (!confirm("Are you sure you want to cancel this raffle?")) return;

    startTransition(async () => {
      try {
        await cancelRaffle(raffleId);
        toast.success("Raffle cancelled");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to cancel raffle");
      }
    });
  }

  return (
    <Button variant="destructive" size="sm" onClick={handleCancel} disabled={isPending}>
      {isPending ? "Cancelling..." : "Cancel Raffle"}
    </Button>
  );
}
