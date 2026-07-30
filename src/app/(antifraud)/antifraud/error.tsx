"use client";

import { useEffect } from "react";
import { AlertTriangle, RotateCw } from "lucide-react";

import { HostLink } from "@/components/host-link";
import { Button } from "@/components/ui/button";

export default function AntifraudError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[antifraud] error boundary caught:", error);
  }, [error]);

  return (
    <div className="space-y-5 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300">
      <div className="rounded-xl border bg-card p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <div className="flex size-11 items-center justify-center rounded-xl bg-rose-500/10 ring-1 ring-rose-500/30">
            <AlertTriangle className="size-5 text-rose-500" aria-hidden />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold leading-tight tracking-tight">
              Couldn&apos;t load this Fraud surface
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              This route failed in isolation, so the Fraud shell and navigation
              remain available. Retry the route or return to the dashboard.
              {error.digest && (
                <span className="ml-1 font-mono text-xs">
                  (correlation {error.digest})
                </span>
              )}
            </p>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
        <p className="text-xs text-muted-foreground">
          A render failure does not prove that a preceding action failed. If
          this appeared after a review, lock, KYC, refund, or settings action,
          check the visible state and audit trail before retrying it. Server
          logs use the correlation ID above without exposing the raw error.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" onClick={reset}>
          <RotateCw className="size-4" />
          Try again
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          render={<HostLink href="/antifraud" />}
        >
          Dashboard
        </Button>
      </div>
    </div>
  );
}
