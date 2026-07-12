"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, RotateCw } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Route-level error boundary for `/pack-studio/cards` (Card Editor).
 *
 * The editor streams the catalog list + KPI strip + filter bar (each MAIN
 * read-only, individually safeQuery-wrapped). Those degrade to tile
 * fallbacks on their own; this boundary is the last line for anything that
 * escapes them (e.g. a throw in the frame `getSets` read or the access
 * gate). Catches INSIDE the Studio shell so the sidebar survives; `reset()`
 * re-runs the render.
 *
 * SAFETY: the "Delete all unused" flow is an admin-only, audited, confirmed
 * action — a render failure here deleted nothing.
 * SECURITY: the raw `error.message` is never rendered; the digest is the
 * safe handle.
 */
export default function CardEditorError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[pack-studio/cards] error boundary caught:", error);
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
              Couldn&apos;t load the Card Editor
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              The card catalog failed before it could render. The error was
              logged — try again, or head back to the Studio overview.
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
          The catalog is read-only here — no card was modified by this error
          (the &quot;Delete all unused&quot; flow is a separate admin-only,
          confirmed, audited action). Server logs matched by the digest above
          carry the stack.
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
          render={<Link href="/pack-studio" />}
        >
          <ArrowLeft className="size-4" />
          Back to Studio
        </Button>
      </div>
    </div>
  );
}
