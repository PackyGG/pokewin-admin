"use client";

import { useTransition } from "react";
import { Calculator } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ux";
import { formatCurrency } from "@/lib/utils/format";

import { settleCreatorPnlDealAction } from "./pnl-settlement-actions";

export function PnlSettlementButton(props: {
  userId: string;
  dealId: string;
  expectedVersion: number;
  retry: boolean;
}) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await settleCreatorPnlDealAction({
            userId: props.userId,
            dealId: props.dealId,
            expectedVersion: props.expectedVersion,
          });
          if (!result.success) {
            toast.error(result.error);
            return;
          }
          toast.success(
            `Settled ${formatCurrency(result.frameSitePnlUsd)} frame PnL · ${formatCurrency(result.creatorShareUsd)} payout`,
          );
        })
      }
    >
      {pending ? <Spinner size={14} /> : <Calculator className="size-3.5" />}
      {pending ? "Settling…" : props.retry ? "Retry settlement" : "Settle frame"}
    </Button>
  );
}
