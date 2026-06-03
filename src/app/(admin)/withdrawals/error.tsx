"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, RotateCw, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHero } from "@/components/modern-panels";

/**
 * Route-level error boundary for /withdrawals. Renders a recoverable
 * state when the pending-withdrawals query throws so the queue is
 * never left as an opaque "Application error" overlay.
 */
export default function WithdrawalsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[withdrawals] page error boundary caught:", error);
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
              Couldn&apos;t load pending withdrawals
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              The withdrawal-requests query failed while rendering. The error
              was logged — pending requests are not lost, just temporarily
              hidden until this page recovers.
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
          No withdrawal has been auto-approved or auto-rejected as a result of
          this error — the queue is safe. Server logs have the full stack
          trace.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Button type="button" variant="default" size="sm" onClick={reset}>
          <RotateCw className="size-4" />
          Try again
        </Button>
        <Button variant="outline" size="sm" render={<Link href="/dashboard" />}>
          <ArrowLeft className="size-4" />
          Back to dashboard
        </Button>
      </div>
    </div>
  );
}
