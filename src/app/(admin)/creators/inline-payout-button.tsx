"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { processCreatorPayout } from "./actions";
import { formatCurrency } from "@/lib/utils/format";

export function InlinePayoutButton({
  userId,
  availableUsd,
}: {
  userId: string;
  availableUsd: number;
}) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  if (availableUsd <= 0) return null;

  function handlePayout() {
    startTransition(async () => {
      try {
        await processCreatorPayout(userId);
        toast.success("Payout processed");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to process payout");
      }
    });
  }

  return (
    <Button size="sm" variant="outline" className="h-6 text-xs px-2" onClick={handlePayout} disabled={isPending}>
      {isPending ? "..." : `Payout ${formatCurrency(availableUsd)}`}
    </Button>
  );
}
