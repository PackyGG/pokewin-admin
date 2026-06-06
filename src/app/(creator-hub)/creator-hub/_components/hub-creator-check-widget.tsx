import Link from "next/link";
import { ChevronRight, Radar, Tv, Twitter } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Dashboard promo card — surfaces Creator Check (Kick / X recon) with a
 * direct link to `/creator-hub/creator-check`.
 */
export function HubCreatorCheckWidget() {
  return (
    <Link
      href="/creator-hub/creator-check"
      className={cn(
        "group flex items-center gap-4 rounded-2xl border bg-card p-4 outline-none transition-colors sm:p-5",
        "hover:border-border/80 hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-cyan-500/15">
        <Radar className="size-5 text-cyan-600 dark:text-cyan-400" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold">Creator Check</span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Tv className="size-3" />
            Kick
          </span>
          <span className="text-muted-foreground/40">·</span>
          <span className="inline-flex items-center gap-1">
            <Twitter className="size-3" />
            X / Twitter
          </span>
          <span className="text-muted-foreground/40">·</span>
          <span>Look up any handle before you sign</span>
        </span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground/50 transition-transform motion-safe:group-hover:translate-x-0.5" />
    </Link>
  );
}
