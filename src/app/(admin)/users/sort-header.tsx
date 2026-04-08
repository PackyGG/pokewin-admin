"use client";

import { ArrowUp, ArrowDown, ArrowUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useUsersSort } from "./sort-context";

export function UsersSortHeader({
  title,
  sortKey,
}: {
  title: string;
  sortKey: string;
}) {
  const { sortBy, sortOrder, setSort } = useUsersSort();
  const isActive = sortBy === sortKey;

  function handleClick() {
    const nextOrder =
      isActive && sortOrder === "asc" ? "desc" : isActive ? "asc" : "desc";
    setSort(sortKey, nextOrder);
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      className="-ml-3 h-8"
      onClick={handleClick}
    >
      {title}
      {isActive ? (
        sortOrder === "asc" ? (
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
