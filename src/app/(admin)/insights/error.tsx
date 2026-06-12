"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, RotateCw, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHero } from "@/components/modern-panels";

/**
 * Route-level error boundary for the entire /insights tree (analytics,
 * games, cost-breakdown, balance-adjustments, edge-calc, streamers, and
 * the rewards-insights sub-tree: affiliate / deposit-bonus / race /
 * rakeback / signup).
 *
 * Insights is the heaviest read path in the admin: lifetime forward
 * scans, multi-query reward-ROI batches, GGR/NGR fan-outs, percentile
 * aggregates. A single slow upstream — or a Prisma column that drifted
 * — can take a whole tab down. Without this boundary those throws bubble
 * to the umbrella `(admin)/error.tsx`; with it, the failure is scoped to
 * insights and the copy is accurate. The reset path re-runs the server
 * render without a full reload, which clears most transient timeouts.
 *
 * SECURITY: the raw `error.message` is never rendered — only the digest
 * (safe correlation handle) is shown. Full stack lives in server logs.
 */
export default function InsightsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[insights] page error boundary caught:", error);
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
              Couldn&apos;t load insights
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              One of the insights aggregates failed while rendering. The
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
      </PageHero>

      <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
        <p className="text-xs text-muted-foreground">
          Insights queries fan out across reward-ROI batches, GGR/NGR
          aggregates, and lifetime scans — a single slow upstream or a stale
          Prisma column can collapse the whole report. Most are cached and
          time-bounded, so a retry usually picks up a warmed result. Server
          logs have the full stack — search for the digest above.
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
