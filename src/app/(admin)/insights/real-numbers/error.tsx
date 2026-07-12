"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, RotateCw, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Route-level error boundary for /insights/real-numbers.
 *
 * Real Numbers fans out across the heaviest reads in the admin — the
 * lifetime cost-breakdown assembly, the insights-hub wager, the per-game
 * GGR split, the realized-P&L snapshot, the reward-spend itemization and
 * the creator-program legs. The page already degrades each leg via
 * `safeQuery` (a slow/failed leg falls back to its own TileErrorFallback),
 * but a hard throw OUTSIDE those legs (e.g. the `requirePageAccess` gate or
 * a render-time fault) would otherwise bubble to the tree-wide
 * `(admin)/insights/error.tsx`. Scoping a boundary here keeps the failure —
 * and the `reset()` re-render — local to this route, so retrying re-runs
 * just the Real Numbers server render (which clears most transient
 * timeouts) instead of the whole insights tree.
 *
 * SECURITY: the raw `error.message` is never rendered — only the digest
 * (safe correlation handle) is shown. Full stack lives in server logs.
 */
export default function RealNumbersError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[insights/real-numbers] page error boundary caught:", error);
  }, [error]);

  return (
    <div className="space-y-5 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300">
      <div className="rounded-xl border bg-card p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <div className="flex size-11 items-center justify-center rounded-xl bg-rose-500/10 ring-1 ring-rose-500/30">
            <AlertTriangle className="size-5 text-rose-500" />
          </div>
          <div className="flex-1">
            <h1 className="text-xl font-semibold leading-tight tracking-tight">
              Couldn&apos;t load Real Numbers
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              One of the source-of-truth aggregates failed while rendering.
              The error was logged — the underlying ledger &amp; balance data
              is intact, just temporarily unreadable from this report view.
              {error.digest && (
                <span className="ml-1 font-mono text-xs">
                  (digest {error.digest})
                </span>
              )}
            </p>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
        <p className="text-xs text-muted-foreground">
          Real Numbers fans out across the lifetime cost-breakdown, the
          GGR/NGR split, the realized-P&amp;L snapshot and the reward-spend
          itemization — a single slow upstream or a stale Prisma column can
          collapse the report. Most reads are cached and time-bounded, so a
          retry usually picks up a warmed result. Server logs have the full
          stack — search for the digest above.
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
          nativeButton={false}
          render={<Link href="/dashboard" />}
        >
          <ArrowLeft className="size-4" />
          Back to dashboard
        </Button>
      </div>
    </div>
  );
}
