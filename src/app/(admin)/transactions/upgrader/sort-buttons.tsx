"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { Loader2, X, Crown, DollarSign } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * One-click shortcuts to rank /transactions/upgrader by the biggest
 * upgrader wins across the WHOLE table, not just the current page.
 *
 *   • "Top multiplier" → sortBy=multiplier → won/bet ratio DESC
 *   • "Top win $"      → sortBy=wonAmount → won_amount DESC
 *
 * The sort runs server-side inside the same SQL pass as the existing
 * outcome / search filters, so pagination walks the globally-sorted
 * dataset — page 1 always shows the biggest hits, page 2 the next
 * twenty, etc.
 *
 * The same component renders a "Recent" reset chip when either sort
 * is active, so admins can return to the default chronological feed
 * without touching the URL bar manually.
 */

type SortKey = "multiplier" | "wonAmount";

function SortButton({
  sortKey,
  label,
  title,
  icon: Icon,
  activeClass,
}: {
  sortKey: SortKey;
  label: string;
  title: string;
  icon: typeof Crown;
  activeClass: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const isActive = searchParams.get("sortBy") === sortKey;

  function handleClick() {
    const params = new URLSearchParams(searchParams.toString());
    params.set("sortBy", sortKey);
    // Drop pagination — biggest hits live on page 1 of the new order,
    // and keeping the previous page index would land the admin
    // mid-dataset with no obvious cue.
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

function ClearSortButton() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const sortBy = searchParams.get("sortBy");
  if (!sortBy || sortBy === "recent") return null;

  function handleClick() {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("sortBy");
    params.delete("page");
    startTransition(() => {
      router.replace(`?${params.toString()}`, { scroll: false });
    });
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleClick}
      disabled={isPending}
      title="Reset to most recent first"
    >
      {isPending ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <X className="size-4" />
      )}
      Recent
    </Button>
  );
}

/** "Top multiplier" — biggest realized won/bet ratio on a winning game. */
export function SortByMultiplierButton() {
  return (
    <SortButton
      sortKey="multiplier"
      label="Top multiplier"
      title="Rank upgrader games by biggest win multiplier (won/bet) — across the whole table, not just this page"
      icon={Crown}
      // House-POV: a big multiplier = a big payout = house loss → rose.
      activeClass="bg-rose-600 hover:bg-rose-600/90"
    />
  );
}

/** "Top win $" — biggest absolute dollar payout to the user. */
export function SortByWonAmountButton() {
  return (
    <SortButton
      sortKey="wonAmount"
      label="Top win $"
      title="Rank upgrader games by biggest payout to the user — across the whole table, not just this page"
      icon={DollarSign}
      // Same rationale — biggest absolute payout = biggest house loss.
      activeClass="bg-rose-600 hover:bg-rose-600/90"
    />
  );
}

/** Reset chip — only renders when a non-default sort is active. */
export { ClearSortButton };
