"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, RotateCw, ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Catch-all error boundary for the entire `(creator-hub)` route group.
 *
 * Before this file existed there was NO `error.tsx` anywhere under
 * `(creator-hub)` — any uncaught server throw (a backend API blip inside a
 * card, an ADMIN-DB read failing mid-tab, the hub layout's own reads) fell
 * all the way through to the root `global-error.tsx` white screen. This
 * umbrella mirrors `src/app/(admin)/error.tsx` exactly: calm copy, digest
 * for log correlation, `reset()` retry, and a way back home.
 *
 * Note Next routes errors to the NEAREST `error.tsx` ancestor — the
 * segment-level boundary at `creator-hub/creators/[id]/error.tsx` takes
 * precedence for the creator detail page (and renders INSIDE the hub
 * shell); this group-level file is the fallback for every other hub
 * surface plus the hub layout itself.
 *
 * SECURITY: `error.message` is intentionally NOT rendered — an admin-facing
 * surface must never echo a raw upstream error (Postgres errors can carry
 * the failed SQL + params). The digest is the safe correlation handle.
 */
export default function CreatorHubError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[creator-hub] error boundary caught:", error);
  }, [error]);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-5 p-6 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300">
      <div className="rounded-xl border bg-card p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <div className="flex size-11 items-center justify-center rounded-xl bg-rose-500/10 ring-1 ring-rose-500/30">
            <AlertTriangle className="size-5 text-rose-500" />
          </div>
          <div className="flex-1">
            <h1 className="text-xl font-semibold leading-tight tracking-tight">
              Something broke in the Creator Hub
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              An unexpected error happened while rendering this page. The
              error was logged — most transient failures clear on a retry.
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
          The most common causes: a backend / DB query that errored, a
          generated schema field that doesn&apos;t exist on the live DB yet, or
          a transient network blip to the backend API. Server logs (Vercel
          Functions) have the full stack — search for the digest above.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Button type="button" variant="default" size="sm" onClick={reset}>
          <RotateCw className="size-4" />
          Try again
        </Button>
        <Button variant="outline" size="sm" nativeButton={false} render={<Link href="/creator-hub" />}>
          <ArrowLeft className="size-4" />
          Back to Creator Hub
        </Button>
      </div>
    </div>
  );
}
