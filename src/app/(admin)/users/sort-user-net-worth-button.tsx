"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { UserRound, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Rank by combined on-site holdings (balance + inventory + vouchers)
 * for **player accounts only** — excludes creators, admins, and support.
 *
 * Same `netHoldings` sort as {@link SortByNetHoldingsButton} with
 * `role=user` pinned so creator deal balances don't dominate the list.
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
      className={cn(isActive && "cursor-default")}
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
