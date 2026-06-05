"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { ArrowUp, ArrowDown, ArrowUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";

export function DataTableColumnHeader({
  title,
  sortKey,
}: {
  title: string;
  sortKey: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const currentSort = searchParams.get("sortBy");
  const currentOrder = searchParams.get("sortOrder") ?? "desc";
  const isActive = currentSort === sortKey;
  // aria-sort communicates the current sort direction to assistive
  // tech as the canonical WAI-ARIA value ("ascending" / "descending" /
  // "none"). Inactive columns advertise "none" so a screen-reader
  // user can tell which column is currently driving the order.
  const ariaSort: "ascending" | "descending" | "none" = isActive
    ? currentOrder === "asc"
      ? "ascending"
      : "descending"
    : "none";
  // Compose a spoken label so the click target reads as
  // "Sort by <Title>, currently <state>" rather than just the visible
  // word. Direction the next click will switch to is included for
  // discoverability.
  const nextDirection = isActive && currentOrder === "asc" ? "descending" : "ascending";
  const ariaLabel = isActive
    ? `Sort by ${title}, currently ${ariaSort}. Activate to sort ${nextDirection}.`
    : `Sort by ${title}. Activate to sort ${nextDirection}.`;

  function handleSort() {
    const params = new URLSearchParams(searchParams.toString());
    params.set("sortBy", sortKey);
    params.set("sortOrder", isActive && currentOrder === "asc" ? "desc" : "asc");
    router.push(`?${params.toString()}`);
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      className="-ml-3 h-8"
      onClick={handleSort}
      aria-sort={ariaSort}
      aria-label={ariaLabel}
    >
      {title}
      {isActive ? (
        currentOrder === "asc" ? (
          <ArrowUp className="ml-1 size-3" aria-hidden />
        ) : (
          <ArrowDown className="ml-1 size-3" aria-hidden />
        )
      ) : (
        <ArrowUpDown className="ml-1 size-3" aria-hidden />
      )}
    </Button>
  );
}
