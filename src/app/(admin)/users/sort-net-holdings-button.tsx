"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { Coins, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * One-click shortcut to rank the users list by combined on-site
 * holdings — available balance + locked vault balance + open
 * inventory value (the `netHoldings` sort). Surfaces the biggest
 * whales without making the admin scroll the wide table to find the
 * "Net" column header.
 *
 * It drives the exact same URL params (`sortBy` / `sortOrder`) that
 * the column-header sort uses, so the server query + the client-side
 * `UsersSortProvider` stay in sync. Resetting `page` mirrors the
 * sort-context behaviour: the highest holders live on page 1.
 */
export function SortByNetHoldingsButton() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  // Active = list is already sorted by net holdings, descending. We
  // only offer the descending direction here (highest first) — the
  // whole point of the button is "show me the biggest holders".
  const isActive =
    searchParams.get("sortBy") === "netHoldings" &&
    (searchParams.get("sortOrder") ?? "desc") === "desc";

  function handleClick() {
    const params = new URLSearchParams(searchParams.toString());
    params.set("sortBy", "netHoldings");
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
      className={cn(isActive && "cursor-default")}
      title="Rank users by balance + inventory value combined"
    >
      {isPending ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <Coins className="size-4" />
      )}
      Top balance + inventory
    </Button>
  );
}
