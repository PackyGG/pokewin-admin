"use client";

import { useEffect } from "react";
import { AlertTriangle, RefreshCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Final safety net for the /creators tree. The page already catches
 * known backend errors and renders an inline state, but if anything
 * else throws (rendering bug, unexpected runtime exception) this
 * boundary surfaces a clean message instead of Next.js's generic
 * "Application error" overlay.
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
    <div className="space-y-5">
      <div className="flex items-center gap-3 pb-4 border-b">
        <div className="flex size-10 items-center justify-center rounded-xl bg-rose-500/10">
          <AlertTriangle className="size-5 text-rose-500" />
        </div>
        <div>
          <h1 className="text-xl font-semibold leading-tight tracking-tight">
            Creators page hit an error
          </h1>
          <p className="text-sm text-muted-foreground">
            {error.message || "Something went wrong rendering this page."}
            {error.digest && (
              <span className="ml-1 font-mono text-xs">
                (digest {error.digest})
              </span>
            )}
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-4">
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
          are set in the Vercel project. Server logs have the full stack.
        </p>
      </div>

      <Button type="button" variant="outline" size="sm" onClick={reset}>
        <RefreshCcw className="size-4" />
        Try again
      </Button>
    </div>
  );
}
