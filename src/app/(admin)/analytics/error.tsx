"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, RotateCw, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Route-level error boundary for /analytics.
 *
 * Why this segment gets its own boundary instead of falling through to
 * the umbrella `(admin)/error.tsx`: the analytics tree is the heaviest
 * query path in the admin (multi-level cohorts, PERCENTILE_CONT, LTV
 * funnels, choropleth map data). A single slow upstream — or a Prisma
 * schema field that drifted — takes the entire tab down. The
 * segment-specific copy reassures the admin that the underlying data
 * isn't broken, only the read path that builds the report.
 */
export default function AnalyticsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[analytics] page error boundary caught:", error);
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
              Couldn&apos;t load analytics
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              One of the analytics aggregates failed while rendering. The
              error was logged — the underlying ledger data is intact, just
              temporarily unreadable from this report view.
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
          Analytics queries fan out across cohorts, retention windows, and
          deposit/wager aggregates — a single slow upstream or a stale
          Prisma column can collapse the whole report. Server logs have
          the full stack trace.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Button type="button" variant="default" size="sm" onClick={reset}>
          <RotateCw className="size-4" />
          Try again
        </Button>
        <Button variant="outline" size="sm" nativeButton={false} render={<Link href="/dashboard" />}>
          <ArrowLeft className="size-4" />
          Back to dashboard
        </Button>
      </div>
    </div>
  );
}
