"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, RotateCw, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Route-level error boundary for the /admin-users/roles subtree (the
 * custom-role editor at /admin-users/roles/[id]).
 *
 * The Roles & Permissions content was merged into /admin-users as a tab; the
 * standalone editor route relocated here from /settings/roles/[id] and brought
 * this boundary with it. It reads role / permission definitions from the admin
 * DB — a failed query or a stale column would otherwise bubble to the umbrella
 * `(admin)/error.tsx`; this boundary keeps it scoped to the roles editor. (The
 * Roles TAB itself renders inside /admin-users and is covered by that route's
 * own error boundary.) The reset path re-runs the server render without a full
 * reload.
 *
 * SECURITY: the raw `error.message` is never rendered — only the digest
 * (safe correlation handle) is shown. Full stack lives in server logs.
 */
export default function RolesError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[admin-users/roles] page error boundary caught:", error);
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
              Couldn&apos;t load roles
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              The roles query failed while rendering. The error was logged
              — no role or permission was modified by this error.
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
          The roles pages read role / permission definitions from the admin
          DB — only the read path failed, the records are unchanged. A
          transient timeout or a stale column is the most common cause.
          Server logs have the full stack — search for the digest above.
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
