"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const AUTO_REFRESH_MS = 15_000;

/**
 * Manual + optional auto-refresh control for the Monitor page. Calls
 * `router.refresh()` to re-run the Server Component (which re-fetches the
 * live overview). Auto-refresh is OFF by default, gated behind a toggle, and
 * its interval is cleared on unmount / when toggled off.
 */
export function MonitorRefreshButton() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [auto, setAuto] = useState(false);
  // Hold the latest refresh fn in a ref so the interval effect doesn't need
  // `router` in its dep array (which would tear down + recreate the timer).
  const refreshRef = useRef(() => router.refresh());
  refreshRef.current = () => startTransition(() => router.refresh());

  useEffect(() => {
    if (!auto) return;
    const id = setInterval(() => refreshRef.current(), AUTO_REFRESH_MS);
    return () => clearInterval(id);
  }, [auto]);

  return (
    <div className="flex items-center gap-2">
      <label className="flex select-none items-center gap-1.5 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={auto}
          onChange={(e) => setAuto(e.target.checked)}
          className="size-3.5 rounded border-input accent-primary"
        />
        Auto-refresh 15s
      </label>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => startTransition(() => router.refresh())}
        disabled={isPending}
      >
        <RotateCw
          className={cn("size-4", isPending && "motion-safe:animate-spin")}
        />
        Refresh
      </Button>
    </div>
  );
}
