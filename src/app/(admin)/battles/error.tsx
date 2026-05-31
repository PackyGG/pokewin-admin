"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, RotateCw, Swords } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHero } from "@/components/modern-panels";

/**
 * Route-level error boundary for /battles.
 *
 * Battles is mutation-heavy (cancel + refund flows) so an opaque
 * "Application error" overlay here would feel especially unsafe — the
 * admin needs to know the queue itself is intact. This boundary makes
 * that explicit. The reset path re-runs the server render without
 * touching ledger state.
 */
export default function BattlesError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[battles] page error boundary caught:", error);
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
              Couldn&apos;t load battles
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              The battles query failed while rendering. The error was
              logged — no battle has been auto-cancelled, refunded, or
              settled as a result of this error.
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
          Battle ledger entries are immutable; the queue is safe to
          retry. Most common cause: a bad filter or upstream timeout
          against the battles table. Server logs have the full stack.
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
          render={<Link href="/battles" />}
        >
          <Swords className="size-4" />
          Reload battles
        </Button>
      </div>
    </div>
  );
}
