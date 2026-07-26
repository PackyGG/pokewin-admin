"use client";

import { useEffect } from "react";
import { HostLink } from "@/components/host-link";
import { AlertTriangle, ArrowLeft, RotateCw } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Route-level error boundary for `/pack-studio/drafts` (operator-only draft
 * staging).
 *
 * The drafts list streams the pending `status='draft'` rows (ADMIN, cached).
 * If that read throws before the list paints, this scoped card catches it
 * INSIDE the Studio shell (sidebar + header survive) instead of
 * white-screening to the group boundary. `reset()` re-runs the render.
 *
 * SAFETY: staging a draft is ADMIN-only (no MAIN write); the ONLY MAIN write
 * is the explicit "Push to prod" / "Push all" action, which wraps the paranoid
 * `applyPackEdit`. A render/read failure here pushed nothing.
 * SECURITY: the raw `error.message` is never rendered; the digest is the
 * safe handle.
 */
export default function PackDraftsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[pack-studio/drafts] error boundary caught:", error);
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
              Couldn&apos;t load Pack Drafts
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              The pending-drafts list failed before it could render. The error
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
          Drafts live in the ADMIN DB and never touch MAIN until you push —
          nothing was pushed or modified by this error. Server logs matched by
          the digest above carry the stack.
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
