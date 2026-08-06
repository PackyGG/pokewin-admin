"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";

/**
 * Single-purpose URL-state toggle for the Deposits list's "$200+"
 * filter. Off = no filter (default). On = `?minAmount=200` in the
 * URL, which `getDepositTransactions` reads and adds to the SQL
 * WHERE clause. We deliberately don't expose an arbitrary number
 * input — the admin spec was a fixed $200 threshold for the big-
 * deposit view.
 */
const BIG_DEPOSIT_THRESHOLD = 200;

export function BigDepositsToggle() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  // Treat any minAmount param at or above the threshold as "on" so
  // a refresh / back-button reload reflects the toggle correctly.
  const current = searchParams.get("minAmount");
  const isOn =
    current != null &&
    Number.isFinite(Number(current)) &&
    Number(current) >= BIG_DEPOSIT_THRESHOLD;

  function handleChange(checked: boolean) {
    const params = new URLSearchParams(searchParams.toString());
    if (checked) {
      params.set("minAmount", String(BIG_DEPOSIT_THRESHOLD));
    } else {
      params.delete("minAmount");
    }
    // Always drop the pagination cursor when the filter changes —
    // staying on page 5 of a filter that now shrinks the result set
    // would look like the page is empty.
    params.delete("page");
    startTransition(() => {
      router.replace(`?${params.toString()}`, { scroll: false });
    });
  }

  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-background/50 px-3 h-9">
      <Switch
        id="big-deposits-toggle"
        checked={isOn}
        onCheckedChange={handleChange}
        disabled={isPending}
      />
      <Label
        htmlFor="big-deposits-toggle"
        className="text-xs font-medium cursor-pointer select-none"
      >
        $200+
      </Label>
    </div>
  );
}
