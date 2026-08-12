"use client";

import { reportWebappError } from "@/lib/errors/report-webapp-error";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, RotateCw, LayoutDashboard } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Route-level error boundary for /dashboard. Surfaces a clean message
 * if any of the dashboard metric queries throw at render time instead
 * of falling through to Next.js's generic "Application error" overlay.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportWebappError({
      source: "react-boundary",
      boundary: "(admin)/dashboard",
      error,
      digest: error.digest,
    });
    console.error("[dashboard] page error boundary caught:", error);
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
              Couldn&apos;t load the dashboard
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              One of the metrics queries failed while rendering this page. The
              error was logged — try refreshing in a moment.
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
          Dashboard charts and KPIs aggregate data across the entire platform,
          so a single slow or unreachable upstream can take the whole view
          down. Server logs have the full stack trace.
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
          <LayoutDashboard className="size-4" />
          Reload dashboard
        </Button>
      </div>
    </div>
  );
}
