"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { formatCurrency } from "@/lib/utils/format";
import { updateCreatorLimits } from "./actions";
import type { CreatorLimits } from "@/lib/queries/creators";

export function InlineLimits({
  userId,
  limits,
}: {
  userId: string;
  limits: CreatorLimits;
}) {
  const [open, setOpen] = useState(false);
  const [currencyLimit, setCurrencyLimit] = useState(limits.currencyLimitAmount ? String(limits.currencyLimitAmount) : "");
  const [percentageLimit, setPercentageLimit] = useState(limits.percentageLimit ? String(limits.percentageLimit * 100) : "");
  const [tipLimit, setTipLimit] = useState(limits.tipLimit ? String(limits.tipLimit) : "");
  const [resetDays, setResetDays] = useState(limits.currencyLimitResetDays ? String(limits.currencyLimitResetDays) : "");
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const hasLimits = limits.currencyLimitAmount || limits.percentageLimit || limits.tipLimit || limits.currencyLimitResetDays;

  const summary = hasLimits
    ? [
        limits.currencyLimitAmount ? `Limit: ${formatCurrency(limits.currencyLimitAmount)}` : null,
        limits.percentageLimit ? `Pct: ${(limits.percentageLimit * 100).toFixed(0)}%` : null,
        limits.tipLimit ? `Tip: ${formatCurrency(limits.tipLimit)}` : null,
        limits.currencyLimitResetDays ? `Reset: ${limits.currencyLimitResetDays}d` : null,
      ].filter(Boolean).join(" · ")
    : "No limits";

  function handleSave() {
    startTransition(async () => {
      try {
        await updateCreatorLimits(userId, {
          currencyLimitAmount: currencyLimit ? parseFloat(currencyLimit) : null,
          percentageLimit: percentageLimit ? parseFloat(percentageLimit) / 100 : null,
          tipLimit: tipLimit ? parseFloat(tipLimit) : null,
          currencyLimitResetDays: resetDays ? parseInt(resetDays, 10) : null,
        });
        toast.success("Limits updated");
        setOpen(false);
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to update limits");
      }
    });
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<button className="text-xs text-muted-foreground hover:text-foreground transition-colors text-left" />}
      >
        {summary}
      </PopoverTrigger>
      <PopoverContent className="w-[260px] space-y-3 p-4" align="start">
        <p className="text-sm font-medium">Withdrawal Limits</p>
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground w-20">Currency</span>
            <Input
              type="number" step="0.01" min="0" placeholder="No limit"
              value={currencyLimit} onChange={(e) => setCurrencyLimit(e.target.value)}
              className="h-7 text-xs"
              onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground w-20">Percent</span>
            <Input
              type="number" step="0.1" min="0" max="100" placeholder="No limit"
              value={percentageLimit} onChange={(e) => setPercentageLimit(e.target.value)}
              className="h-7 text-xs"
              onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground w-20">Tip</span>
            <Input
              type="number" step="0.01" min="0" placeholder="No limit"
              value={tipLimit} onChange={(e) => setTipLimit(e.target.value)}
              className="h-7 text-xs"
              onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground w-20">Reset days</span>
            <Input
              type="number" min="1" placeholder="No reset"
              value={resetDays} onChange={(e) => setResetDays(e.target.value)}
              className="h-7 text-xs"
              onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
            />
          </div>
        </div>
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setOpen(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button size="sm" className="h-7 text-xs" onClick={handleSave} disabled={isPending}>
            {isPending ? "..." : "Save"}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
