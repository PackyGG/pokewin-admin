"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, RotateCw, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHero } from "@/components/modern-panels";

/**
 * Route-level error boundary for /system/monitor.
 *
 * The page's data fetch (`getMonitorOverview`) is designed to NEVER throw —
 * it returns a typed result the view renders cleanly for every failure mode.
 * This boundary therefore only catches a hard throw OUTSIDE that path (the
 * `requirePageAccess` gate or a render-time fault), keeping the failure local
 * to this route so a retry re-runs just the Monitor render.
 *
 * SECURITY: never render the raw `error.message` (it could carry internal
 * detail) — only the digest correlation handle is shown.
 */
export default function MonitorError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[system/monitor] page error boundary caught:", error);
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
              Couldn&apos;t load Monitor
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              The Monitor page failed to render. This is an app-side error, not
              a signal about the backend monitor service itself.
              {error.digest && (
                <span className="ml-1 font-mono text-xs">
                  (digest {error.digest})
                </span>
              )}
            </p>
          </div>
        </div>
      </PageHero>

      <div className="flex items-center gap-2">
        <Button type="button" variant="default" size="sm" onClick={reset}>
          <RotateCw className="size-4" aria-hidden />
          Try again
        </Button>
        <Button
          variant="outline"
          size="sm"
          nativeButton={false}
          render={<Link href="/dashboard" />}
        >
          <ArrowLeft className="size-4" aria-hidden />
          Back to dashboard
        </Button>
      </div>
    </div>
  );
}
