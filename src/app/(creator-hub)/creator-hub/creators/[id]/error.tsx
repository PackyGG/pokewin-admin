"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, RotateCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { PageHero } from "@/components/modern-panels";

/**
 * Segment-level error boundary for `/creator-hub/creators/[id]`.
 *
 * Renders INSIDE the hub shell (the layout above survives), so an
 * uncaught throw from the banner, a tab body, or a tab's query no longer
 * white-screens into `global-error.tsx` — the manager keeps the sidebar
 * and gets a retry that re-renders just this segment. Mirrors
 * `src/app/(admin)/users/[id]/error.tsx`.
 *
 * Per-leg failures (KPI strip, Creator Net, cohorts, sessions, …) are
 * handled by the in-page amber bands; this boundary is the LAST line for
 * anything that escapes them.
 *
 * SECURITY: `error.message` is intentionally NOT rendered — never echo a
 * raw upstream error. The digest is the safe correlation handle.
 */
export default function CreatorHubCreatorDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[creator-hub/creators/[id]] error boundary caught:", error);
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
              Couldn&apos;t load this creator
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              A creator-detail query failed before the page could render.
              The error was logged — try again, or head back to the roster
              and re-open the profile.
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
          One of the detail queries (KPI aggregate, P&amp;L, a tab body)
          threw or the backend API was unreachable. If &quot;Try again&quot;
          keeps failing the issue is upstream — the server logs carry the
          full stack under the digest above.
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
          render={<Link href="/creator-hub/creators" />}
        >
          <ArrowLeft className="size-4" />
          Back to creators
        </Button>
      </div>
    </div>
  );
}
