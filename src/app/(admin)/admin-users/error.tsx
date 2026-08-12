"use client";

import { reportWebappError } from "@/lib/errors/report-webapp-error";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, RotateCw, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Route-level error boundary for the /admin-users tree (list, [id],
 * balance-limits).
 *
 * These pages read the admin DB (admin_users, admin_sessions,
 * admin_balance_limits). A failed query or a stale column would
 * otherwise bubble to the umbrella `(admin)/error.tsx`; this boundary
 * scopes it to /admin-users with a calm "the READ failed, the accounts
 * are fine" message. The reset path re-runs the server render without a
 * full reload.
 *
 * SECURITY: the raw `error.message` is never rendered — only the digest
 * (safe correlation handle) is shown. Full stack lives in server logs.
 */
export default function AdminUsersError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportWebappError({
      source: "react-boundary",
      boundary: "(admin)/admin-users",
      error,
      digest: error.digest,
    });
    console.error("[admin-users] page error boundary caught:", error);
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
              Couldn&apos;t load admin users
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              The admin-users query failed while rendering. The error was
              logged — no admin account, role, or balance limit was modified
              by this error.
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
          These pages read the admin DB (admin_users, admin_sessions,
          admin_balance_limits) — only the read path failed, the records are
          unchanged. A transient timeout or a stale column is the most common
          cause. Server logs have the full stack — search for the digest
          above.
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
