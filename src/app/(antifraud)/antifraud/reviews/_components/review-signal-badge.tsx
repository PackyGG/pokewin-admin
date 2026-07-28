import { cn } from "@/lib/utils";
import {
  isFiatWithdrawalHoldSignal,
  reviewSignalLabel,
} from "@/lib/antifraud/signal-display";

export function ReviewSignalBadge({ signal }: { signal: string }) {
  const isFiatHold = isFiatWithdrawalHoldSignal(signal);

  return (
    <span
      title={
        isFiatHold
          ? "Lifetime completed deposits triggered automatic balance-to-crypto and physical-item withdrawal locks."
          : signal
      }
      className={cn(
        "rounded-sm border px-1.5 py-0.5 text-[10px]",
        isFiatHold
          ? "border-amber-500/30 bg-amber-500/10 font-semibold text-amber-700 dark:text-amber-300"
          : "border-border/60 text-muted-foreground",
      )}
    >
      {reviewSignalLabel(signal)}
    </span>
  );
}
