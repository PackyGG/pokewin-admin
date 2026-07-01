"use client";

import { useEffect, useTransition } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, Loader2, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHero } from "@/components/modern-panels";

/**
 * Segment-level error boundary for /users/[id]. Replaces the inherited
 * /users/error.tsx (which carries list-specific copy "Couldn't load the
 * user list") so a render-time failure on the DETAIL page produces a
 * matching, accurate message instead of pointing the admin at a
 * non-existent "bad filter".
 *
 * The list-level boundary still covers /users itself; this file only
 * scopes to the detail route + its nested segments.
 */
export default function UserDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[users/[id]] page error boundary caught:", error);
  }, [error]);

  // reset() re-renders the segment and re-runs the failed server reads —
  // that can take a beat (a retried DB aggregate). Drive it through a
  // transition so the "Try again" button shows a pending spinner + disables
  // itself instead of looking inert, matching the isPending pattern used by
  // the tab controls in this route.
  const [isRetrying, startRetry] = useTransition();

  return (
    <div className="space-y-5 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300">
      <PageHero>
        <div className="flex items-start gap-3">
          <div className="flex size-11 items-center justify-center rounded-xl bg-rose-500/10 ring-1 ring-rose-500/30">
            <AlertTriangle className="size-5 text-rose-500" />
          </div>
          <div className="flex-1">
            <h1 className="text-xl font-semibold leading-tight tracking-tight">
              Couldn&apos;t load this user
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              The user-detail query failed before the page could render.
              The error was logged — try refreshing, or head back to the
              user list and re-open the profile.
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
          One of the detail-page queries (P&amp;L, risk score, tabs)
          timed out or failed against the main DB. If &quot;Try again&quot;
          keeps failing the issue is upstream — fall back to the user
          list and contact engineering with the digest above.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={() => startRetry(() => reset())}
          disabled={isRetrying}
        >
          {isRetrying ? (
            <Loader2 className="size-4 motion-safe:animate-spin" />
          ) : (
            <RotateCw className="size-4" />
          )}
          {isRetrying ? "Retrying…" : "Try again"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          nativeButton={false}
          render={<Link href="/users" />}
        >
          <ArrowLeft className="size-4" />
          Back to user list
        </Button>
      </div>
    </div>
  );
}

