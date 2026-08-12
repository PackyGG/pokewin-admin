"use client";

import { reportWebappError } from "@/lib/errors/report-webapp-error";

import { useEffect } from "react";
import { HostLink } from "@/components/host-link";
import { AlertTriangle, ArrowLeft, RotateCw } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Route-level error boundary for `/pack-studio/history` (owner-only Change
 * History + revert).
 *
 * The timeline streams the captured `pack_state_snapshots` (ADMIN) joined to
 * live pack + card identity (MAIN, read-only batch reads). If one of those
 * reads throws before the timeline paints, this scoped card catches it INSIDE
 * the Studio shell (sidebar + header survive) instead of white-screening to
 * the group boundary. `reset()` re-runs the render.
 *
 * SAFETY: the only write on this surface is the operator-confirmed,
 * 2FA-guarded `revertPackToSnapshot` — a render/read failure here never
 * reverted a pack.
 * SECURITY: the raw `error.message` is never rendered; the digest is the
 * safe handle.
 */
export default function PackHistoryError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportWebappError({
      source: "react-boundary",
      boundary: "(pack-studio)/pack-studio/history",
      error,
      digest: error.digest,
    });
    console.error("[pack-studio/history] error boundary caught:", error);
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
              Couldn&apos;t load Change History
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              The snapshot timeline failed before it could render. The error
              was logged — try again, or head back to the Studio overview.
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
          The timeline is a read-only join of the ADMIN snapshot log and live
          pack identity — no pack was reverted or modified by this error (the
          revert is a separate 2FA-guarded action). Server logs matched by the
          digest above carry the stack.
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
          render={<HostLink href="/pack-studio" />}
        >
          <ArrowLeft className="size-4" />
          Back to Studio
        </Button>
      </div>
    </div>
  );
}
