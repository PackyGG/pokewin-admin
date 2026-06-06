"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { refetchTwitterTab } from "./twitter-tab-actions";

/**
 * Manual **Refetch** button for the Twitter tab. The only forced-refresh path
 * (no auto-poll, no per-render fetch — owner's no-spam rule). Runs the server
 * action in a transition; the action revalidates the route so the tab re-reads
 * the refreshed cache. The integration's anti-mash floor still applies, so a
 * rapid double-click is served from the DB upstream.
 *
 * Client component — receives only serializable props (`userId` + `handle`);
 * the server action is imported directly (no function prop across the RSC
 * boundary). Follows the house client error pattern (try/catch → sonner).
 */
export function TwitterRefetchButton({
  userId,
  handle,
  size = "sm",
}: {
  userId: string;
  handle: string;
  size?: "sm" | "icon";
}) {
  const [isPending, startTransition] = useTransition();

  function refetch() {
    startTransition(async () => {
      try {
        await refetchTwitterTab(userId, handle);
        toast.success("Twitter data refreshed");
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Could not refresh Twitter data",
        );
      }
    });
  }

  if (size === "icon") {
    return (
      <Button
        type="button"
        size="icon"
        variant="outline"
        className="size-8 shrink-0"
        onClick={refetch}
        disabled={isPending}
        aria-label="Refetch Twitter data"
        title="Refetch Twitter data"
      >
        <RefreshCw className={cn("size-4", isPending && "animate-spin")} />
      </Button>
    );
  }

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={refetch}
      disabled={isPending}
    >
      <RefreshCw className={cn("mr-1.5 size-3.5", isPending && "animate-spin")} />
      {isPending ? "Refreshing…" : "Refetch"}
    </Button>
  );
}
