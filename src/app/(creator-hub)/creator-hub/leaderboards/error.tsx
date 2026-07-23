"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, RotateCw } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Segment-level error boundary for `/creator-hub/leaderboards`.
 *
 * Renders INSIDE the hub shell (the layout above survives), so an
 * uncaught throw from the ranked boards or a leaderboard query no longer
 * white-screens into `global-error.tsx` — the manager keeps the sidebar
 * and gets a retry that re-renders just this segment. Mirrors
 * `src/app/(creator-hub)/creator-hub/creators/[id]/error.tsx`.
 *
 * Per-leg failures are handled by the in-page degraded states; this
 * boundary is the LAST line for anything that escapes them.
 *
 * SECURITY: `error.message` is intentionally NOT rendered — never echo a
 * raw upstream error. The digest is the safe correlation handle.
 */
export default function CreatorHubLeaderboardsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[creator-hub/leaderboards] error boundary caught:", error);
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
              Couldn&apos;t load Live Leaderboards
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              A leaderboard query failed before the page could render.
              The error was logged — try again, or head back to the hub
              dashboard.
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
          One of the leaderboard queries (ranked boards, standings, prize
          pools) threw or the backend API was unreachable. If &quot;Try
          again&quot; keeps failing the issue is upstream — the server
          logs carry the full stack under the digest above.
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
          render={<Link href="/creator-hub" />}
        >
          <ArrowLeft className="size-4" />
          Back to dashboard
        </Button>
      </div>
    </div>
  );
}
