"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { Lock, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * One-click shortcut to rank the users list by `balances.locked_balance`
 * descending — the operator surface for "who has the most cash stuck in
 * vault / wager-lock right now". Same URL-param pattern as the existing
 * net-holdings / pnl shortcuts; the server's filter-first ranking CTE
 * does the full-table ORDER BY (see SORT_AGGREGATE_KEYS.lockedBalance),
 * so this is whole-base, not just the current page slice.
 *
 * House framing: a locked dollar is still a direct house liability
 * (the user gets it back when the lock lifts). Surfacing the largest
 * locked balances helps an operator decide where to step in (force
 * unlock, contact the user, etc.).
 */
export function SortByLockedBalanceButton() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const isActive =
    searchParams.get("sortBy") === "lockedBalance" &&
    (searchParams.get("sortOrder") ?? "desc") === "desc";

  function handleClick() {
    const params = new URLSearchParams(searchParams.toString());
    params.set("sortBy", "lockedBalance");
    params.set("sortOrder", "desc");
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
      className={cn(
        isActive && "cursor-default bg-amber-600 hover:bg-amber-600/90",
      )}
      title="Rank users by who has the most cash parked in vault / wager-lock — across the whole table, not just this page"
    >
      {isPending ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <Lock className="size-4" />
      )}
      Top vault / locked
    </Button>
  );
}
