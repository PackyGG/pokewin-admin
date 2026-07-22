"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { UserRound, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Rank by combined on-site holdings for **player accounts only** —
 * `role=user` pinned, so creators / admins / support can't dominate the
 * list. This is the ONLY net-worth shortcut on the toolbar since the
 * unfiltered "Top balance + inventory" twin was removed (owner,
 * 2026-07-22).
 *
 * What it ranks by is the `netHoldings` sort key, and it is exactly the
 * "Net" column the rows display:
 *
 *   available_balance + locked_balance + open inventory (cards) +
 *   unclaimed vouchers − official_stream/remove_locked carve-out
 *
 * Inventory counts unsold, unexchanged, non-withdrawal-locked rows at
 * `value_at_obtained`; vouchers count `claimed_at IS NULL`. ORDER BY and
 * the displayed value share that one formula (users-list.ts
 * buildRankingOrderExpr vs hydrateUserListPage) — verified cent-exact on
 * the live top 15 against prod, read-only, 2026-07-22.
 */
export function SortByUserNetWorthButton() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const isActive =
    searchParams.get("sortBy") === "netHoldings" &&
    (searchParams.get("sortOrder") ?? "desc") === "desc" &&
    searchParams.get("role") === "user";

  function handleClick() {
    const params = new URLSearchParams(searchParams.toString());
    params.set("sortBy", "netHoldings");
    params.set("sortOrder", "desc");
    params.set("role", "user");
    params.delete("page");
    startTransition(() => {
      router.replace(`?${params.toString()}`, { scroll: false });
    });
  }

  return (
    <Button
      variant={isActive ? "default" : "outline"}
      size="sm"
      onClick={handleClick}
      disabled={isActive || isPending}
      // h-9 px-3 to match the rest of the toolbar row (search input, filter
      // selects, Clear) — `size="sm"` alone is h-7. Same override as the PnL
      // sort buttons beside it.
      className={cn("h-9 px-3", isActive && "cursor-default")}
      title="Rank player accounts by balance + inventory — creators excluded"
    >
      {isPending ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <UserRound className="size-4" />
      )}
      Top user net worth
    </Button>
  );
}
