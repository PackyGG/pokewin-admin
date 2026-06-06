"use client";

import { useRouter, useSearchParams } from "next/navigation";

import { cn } from "@/lib/utils";
import {
  DEAL_TRACKER_WINDOWS,
  type DealTrackerWindow,
} from "../_lib/tracker-window";

export function DealTrackerWindowSelector({
  current,
}: {
  current: DealTrackerWindow;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function select(window: DealTrackerWindow) {
    const params = new URLSearchParams(searchParams.toString());
    if (window === "30d") params.delete("window");
    else params.set("window", window);
    const qs = params.toString();
    router.push(qs ? `?${qs}` : "/creator-hub/deal-tracker");
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {DEAL_TRACKER_WINDOWS.map((w) => (
        <button
          key={w.value}
          type="button"
          onClick={() => select(w.value)}
          className={cn(
            "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
            current === w.value
              ? "border-pink-500/40 bg-pink-500/10 text-foreground"
              : "border-border bg-card text-muted-foreground hover:bg-accent",
          )}
        >
          {w.label}
        </button>
      ))}
    </div>
  );
}
