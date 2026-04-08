"use client";

import { useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowUp, ArrowDown, ArrowUpDown, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTablePending } from "./table-pending-context";

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

  const [isPending, startTransition] = useTransition();
  const { setPending } = useTablePending();

  // Optimistic next-direction so the arrow flips instantly on click.
  const nextOrder = isActive && currentOrder === "asc" ? "desc" : "asc";

  function handleSort() {
    const params = new URLSearchParams(searchParams.toString());
    params.set("sortBy", sortKey);
    params.set("sortOrder", nextOrder);
    setPending(true);
    startTransition(() => {
      router.push(`?${params.toString()}`);
      // The dim will clear when the new server-rendered table replaces the old.
      // We rely on the new render to call setPending(false) on mount.
      setTimeout(() => setPending(false), 50);
    });
  }

  // While THIS header is pending, optimistically render it as active+nextOrder.
  const showActive = isActive || isPending;
  const showOrder = isPending ? nextOrder : currentOrder;

  return (
    <Button
      variant="ghost"
      size="sm"
      className="-ml-3 h-8 data-[active=true]:text-foreground"
      data-active={showActive}
      onClick={handleSort}
      disabled={isPending}
    >
      {title}
      {isPending ? (
        <Loader2 className="ml-1 size-3 animate-spin" />
      ) : showActive ? (
        showOrder === "asc" ? (
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
