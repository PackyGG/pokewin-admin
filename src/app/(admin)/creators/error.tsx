"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, RotateCw, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Final safety net for the /creators tree. The page already catches
 * known backend errors and renders an inline state, but if anything
 * else throws (rendering bug, unexpected runtime exception) this
 * boundary surfaces a clean message instead of Next.js's generic
 * "Application error" overlay.
 *
 * SECURITY: the raw `error.message` is never rendered — only the digest
 * (safe correlation handle) is shown. Full stack lives in server logs.
 */
export default function CreatorsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Server logs already capture the stack via console.error in the
    // page. This logs the client-side rehydration error too so Vercel
    // function logs cover both edges.
    console.error("[creators] page error boundary caught:", error);
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
              Couldn&apos;t load creators
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              A creators query failed while rendering. The error was logged
              — most transient failures clear on a retry.
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
          The most common cause is the backend API not being reachable
          from this deployment — confirm{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">
            BACKEND_API_URL_PROD
          </code>{" "}
          and{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">
            BACKEND_ADMIN_KEY_PROD
          </code>{" "}
          are set in the Vercel project. Server logs have the full stack —
          search for the digest above.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Button type="button" variant="default" size="sm" onClick={reset}>
          <RotateCw className="size-4" />
          Try again
        </Button>
        <Button variant="outline" size="sm" nativeButton={false} render={<Link href="/dashboard" />}>
          <ArrowLeft className="size-4" />
          Back to dashboard
        </Button>
      </div>
    </div>
  );
}
