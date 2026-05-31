"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, RotateCw, Megaphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHero } from "@/components/modern-panels";

/**
 * Route-level error boundary for /marketing (giveaway feed today;
 * scaffolded for the rest of the marketing tree if more sub-routes
 * land later).
 *
 * The giveaway feed cross-references admin-tagged balance adjustments
 * with the social links the admin attached at the time — a stale
 * schema or a missing column on either side can take the whole feed
 * down. This boundary surfaces a clean recoverable message.
 */
export default function MarketingError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[marketing] page error boundary caught:", error);
  }, [error]);

  return (
    <div className="space-y-5 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300">
      <PageHero>
        <div className="flex items-start gap-3">
          <div className="flex size-11 items-center justify-center rounded-xl bg-rose-500/10 ring-1 ring-rose-500/30">
            <AlertTriangle className="size-5 text-rose-500" />
          </div>
          <div className="flex-1">
            <h1 className="text-xl font-semibold leading-tight tracking-tight">
              Couldn&apos;t load marketing
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              A marketing query failed while rendering. The error was
              logged — no giveaway record was modified by this error.
              {error.digest && (
                <span className="ml-1 font-mono text-xs">
                  (digest {error.digest})
                </span>
              )}
            </p>
          </div>
        </div>
      </PageHero>

      <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
        <p className="text-xs text-muted-foreground">
          Likely cause: a balance-adjustment row tagged as a giveaway is
          missing its source link, or the join between
          admin_balance_adjustments and admin_giveaway_links picked up a
          stale column. Server logs (matched by the digest above) carry
          the full stack.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Button type="button" variant="default" size="sm" onClick={reset}>
          <RotateCw className="size-4" />
          Try again
        </Button>
        <Button
          variant="outline"
          size="sm"
          render={<Link href="/marketing/giveaway" />}
        >
          <Megaphone className="size-4" />
          Reload marketing
        </Button>
      </div>
    </div>
  );
}
