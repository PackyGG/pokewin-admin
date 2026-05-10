"use client";

import { useEffect } from "react";
import { AlertTriangle, RefreshCcw } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Catch-all error boundary for the entire `(admin)` route group.
 *
 * Next.js routes errors to the NEAREST `error.tsx` ancestor. Six admin
 * subtrees already define their own (creators, dashboard, salaries,
 * transactions, users, withdrawals). Every OTHER page under `(admin)/`
 * — promo-codes, analytics, battles, packs, gift-cards, vouchers, rain,
 * audit, settings, system, etc. — used to bubble straight up to the
 * generic Vercel "An error occurred in the Server Components render"
 * page. This boundary intercepts those before they leave the admin
 * shell.
 *
 * Behavior:
 *   • Friendly title + the error's message + digest so admins can
 *     correlate with Vercel function logs without opening the console.
 *   • "Try again" hits Next's `reset()` which re-renders the failed
 *     route segment without a full page reload — so a transient query
 *     blip doesn't force the admin to navigate away and back.
 *   • Logs the caught error to the console (server logs already
 *     capture the original throw; this duplicates onto the client
 *     side so devtools shows it without needing Vercel access).
 *
 * Per-route boundaries (e.g. `creators/error.tsx`) still take
 * precedence and can show route-specific guidance (env vars to check,
 * etc.). This file is the umbrella for everything else.
 */
export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[admin] error boundary caught:", error);
  }, [error]);

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3 border-b pb-4">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-rose-500/10">
          <AlertTriangle className="size-5 text-rose-500" />
        </div>
        <div className="min-w-0">
          <h1 className="text-xl font-semibold leading-tight tracking-tight">
            Something broke on this page
          </h1>
          <p className="text-sm text-muted-foreground">
            {/* `error.message` is omitted in production builds — Next 15
                only ships the digest to clients to avoid leaking stacks.
                Either way we render whatever's available so dev/local
                gets the message and prod still gets the digest. */}
            {error.message ||
              "An unexpected error happened while rendering this page."}
            {error.digest && (
              <span className="ml-1 font-mono text-xs">
                (digest {error.digest})
              </span>
            )}
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-4 text-xs text-muted-foreground">
        <p>
          The page didn&apos;t load. Most common causes for this admin app:
          a backend / DB query that errored, a Prisma schema field that
          doesn&apos;t exist on the live DB yet, or a transient network
          blip to the backend API. Server logs (Vercel Functions) have
          the full stack — search for the digest above.
        </p>
        <p className="mt-2">
          Hitting <span className="font-medium">Try again</span> below
          re-runs the page&apos;s server-side render without a full
          reload, which fixes most transient failures. If the same
          error comes back, the issue is structural — escalate with
          the digest.
        </p>
      </div>

      <Button type="button" variant="outline" size="sm" onClick={reset}>
        <RefreshCcw className="size-4" />
        Try again
      </Button>
    </div>
  );
}
