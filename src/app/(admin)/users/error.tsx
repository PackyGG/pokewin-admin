"use client";

import { reportWebappError } from "@/lib/errors/report-webapp-error";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, RotateCw, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Route-level error boundary for /users. Catches render-time errors
 * thrown by the users list query (filters, sorting, pagination) and
 * shows a recoverable state instead of a hard crash.
 */
export default function UsersError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportWebappError({
      source: "react-boundary",
      boundary: "(admin)/users",
      error,
      digest: error.digest,
    });
    console.error("[users] page error boundary caught:", error);
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
              Couldn&apos;t load the user list
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              The users query failed before the page could render. The error
              was logged — try refreshing or clearing active filters.
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
          A single bad filter parameter or an upstream timeout against the
          main DB can take this view down. If &quot;Try again&quot; keeps
          failing, clear active filters from the URL or head back to the
          dashboard. Server logs have the full stack — search for the digest
          above.
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
          // <Link> renders an <a> — Base UI's Button defaults
          // nativeButton:true and console.errors for non-<button> tags.
          nativeButton={false}
          render={<Link href="/dashboard" />}
        >
          <ArrowLeft className="size-4" />
          Back to dashboard
        </Button>
      </div>
    </div>
  );
}
