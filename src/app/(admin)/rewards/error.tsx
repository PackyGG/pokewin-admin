"use client";

import { reportWebappError } from "@/lib/errors/report-webapp-error";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, RotateCw, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Route-level error boundary for the entire /rewards subtree
 * (rewards, rakeback, leaderboards, level-up, settings).
 *
 * The rewards tree owns user-facing balance-add levers — admins must
 * never see an opaque "Application error" overlay here because the
 * affected page can read AS IF the underlying balance levers were
 * unsafe. This boundary surfaces a calm "the READ failed, the data
 * is fine" message so admins don't panic-cancel ongoing promos.
 */
export default function RewardsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportWebappError({
      source: "react-boundary",
      boundary: "(admin)/rewards",
      error,
      digest: error.digest,
    });
    console.error("[rewards] page error boundary caught:", error);
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
              Couldn&apos;t load rewards
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              A rewards query failed while rendering. The error was logged
              — no reward has been auto-issued, claimed, or revoked as a
              result of this error, the queue is safe.
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
          Rewards / rakeback / leaderboards are independent
          aggregates — a failure on one tab does not propagate to the
          others. Hitting Try again re-runs the server render without a
          full reload.
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
