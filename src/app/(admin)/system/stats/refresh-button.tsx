"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Manual refresh for the stats page. Triggers router.refresh() which
 * re-runs the server component data fetch without a full navigation.
 *
 * Relies on useTransition so the icon can spin while the server render
 * is in flight — Next's router.refresh() resolves once new data lands.
 */
export function RefreshButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => startTransition(() => router.refresh())}
      disabled={pending}
      aria-label="Refresh stats"
    >
      <RefreshCw
        className={cn("size-3.5", pending && "motion-safe:animate-spin")}
        aria-hidden
      />
      <span>Refresh</span>
    </Button>
  );
}
