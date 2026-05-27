"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { TrendingUp, TrendingDown, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Two one-click shortcuts to rank the /users list by lifetime P&L
 * across the WHOLE table (not just the current page). The underlying
 * sort key is `pnl` — the same one the column header drives — so the
 * server's raw-SQL pnl ORDER BY runs across every user before
 * pagination. Both buttons reset `page` to 1 so the extreme ends of
 * the distribution surface on top.
 *
 * House-POV framing:
 *   • "Top losers"  → ascending  → biggest house GAINS (users who
 *                                  lost the most to us, emerald PnL
 *                                  in the table)
 *   • "Top winners" → descending → biggest house LOSSES (users who
 *                                  won the most from us, rose PnL)
 *
 * The two buttons share the same component file so toggling between
 * directions is a single import on the page.
 */

type Direction = "asc" | "desc";

function SortByPnlButton({
  direction,
  label,
  title,
  icon: Icon,
  activeClass,
}: {
  direction: Direction;
  label: string;
  title: string;
  icon: typeof TrendingUp;
  activeClass: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const isActive =
    searchParams.get("sortBy") === "pnl" &&
    (searchParams.get("sortOrder") ?? "desc") === direction;

  function handleClick() {
    const params = new URLSearchParams(searchParams.toString());
    params.set("sortBy", "pnl");
    params.set("sortOrder", direction);
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
      className={cn(isActive && "cursor-default", isActive && activeClass)}
      title={title}
    >
      {isPending ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <Icon className="size-4" />
      )}
      {label}
    </Button>
  );
}

/**
 * "Top losers" — users with the worst lifetime user-PnL = biggest
 * house gains. Tops the list with the users who put the most cash
 * INTO the house net.
 */
export function SortByPnlLosersButton() {
  return (
    <SortByPnlButton
      direction="asc"
      label="Top losers"
      title="Rank users by who lost the most to us (house gain) — across the whole table, not just this page"
      icon={TrendingUp}
      activeClass="bg-emerald-600 hover:bg-emerald-600/90"
    />
  );
}

/**
 * "Top winners" — users with the best lifetime user-PnL = biggest
 * house losses. Tops the list with the users who took the most cash
 * OUT net (the ones most worth investigating for fraud / abuse).
 */
export function SortByPnlWinnersButton() {
  return (
    <SortByPnlButton
      direction="desc"
      label="Top winners"
      title="Rank users by who won the most from us (house loss) — across the whole table, not just this page"
      icon={TrendingDown}
      activeClass="bg-rose-600 hover:bg-rose-600/90"
    />
  );
}
