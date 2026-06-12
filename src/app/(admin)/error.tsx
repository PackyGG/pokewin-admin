"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, RotateCw, ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { PageHero } from "@/components/modern-panels";

/**
 * Catch-all error boundary for the entire `(admin)` route group.
 *
 * Next.js routes errors to the NEAREST `error.tsx` ancestor. Many admin
 * subtrees define their own (analytics, battles, creators, dashboard,
 * employees, marketing, packs, rewards, salaries, transactions, users,
 * withdrawals, plus the heavier insights / ggr / cards / rain / etc.
 * trees). Every OTHER page under `(admin)/` falls through to THIS
 * umbrella instead of bubbling to the generic Vercel "An error occurred
 * in the Server Components render" page. This boundary intercepts those
 * before they leave the admin shell.
 *
 * Shared shape across every admin error boundary:
 *   • Calm title + a generic recoverable message + the error's digest
 *     shown small so admins can correlate with Vercel function logs.
 *   • "Try again" hits Next's `reset()` which re-renders the failed
 *     route segment without a full page reload — so a transient query
 *     blip doesn't force the admin to navigate away and back.
 *   • "Back to dashboard" is the always-available home affordance.
 *   • Mirrors the caught error to the browser console (server logs
 *     already capture the original throw; this duplicates onto the
 *     client so devtools shows it without needing Vercel access).
 *
 * SECURITY: `error.message` is intentionally NOT rendered. Next 15
 * strips it from production client payloads anyway, and an admin-facing
 * surface should never echo a raw upstream error (Postgres errors can
 * carry the failed SQL + params). The digest is the safe correlation
 * handle; the full stack lives in the server logs only.
 *
 * Per-route boundaries (e.g. `creators/error.tsx`) still take
 * precedence and can show route-specific guidance (env vars to check,
 * migrations to run, etc.). This file is the umbrella for everything else.
 */
export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[admin] page error boundary caught:", error);
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
              Something broke on this page
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
      </PageHero>

      <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
        <p className="text-xs text-muted-foreground">
          The most common causes for this admin app: a backend / DB query
          that errored, a Prisma schema field that doesn&apos;t exist on the
          live DB yet, or a transient network blip to the backend API.
          Server logs (Vercel Functions) have the full stack — search for
          the digest above.
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
