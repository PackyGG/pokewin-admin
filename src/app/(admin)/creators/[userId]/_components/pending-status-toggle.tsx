"use client";

import { useRouter, useSearchParams } from "next/navigation";

import { cn } from "@/lib/utils";
import type { PendingConversionStatus } from "@/lib/backend-api";

type Props = {
  value: PendingConversionStatus;
};

export function PendingStatusToggle({ value }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function set(next: PendingConversionStatus) {
    if (next === value) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set("pendingStatus", next);
    router.replace(`?${params.toString()}`, { scroll: false });
  }

  return (
    <div className="inline-flex rounded-md border bg-muted/30 p-0.5 text-xs">
      <button
        type="button"
        onClick={() => set("pending")}
        className={cn(
          "rounded-sm px-2.5 py-1 font-medium transition-colors",
          value === "pending"
            ? "bg-background text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        Pending
      </button>
      <button
        type="button"
        onClick={() => set("claimed")}
        className={cn(
          "rounded-sm px-2.5 py-1 font-medium transition-colors",
          value === "claimed"
            ? "bg-background text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        Claimed
      </button>
    </div>
  );
}
