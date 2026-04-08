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
    >
      {title}
      {isActive ? (
        currentOrder === "asc" ? (
          <ArrowUp className="ml-1 size-3" />
        ) : (
          <ArrowDown className="ml-1 size-3" />
        )
      ) : (
        <ArrowUpDown className="ml-1 size-3" />
      )}
    </Button>
  );
}
