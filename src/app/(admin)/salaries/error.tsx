"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, RotateCw, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Catches any throw from /salaries server queries (RPC down, schema
 * still initializing, missing env, etc.) and shows a soft error
 * instead of the raw Vercel runtime overlay.
 *
 * Most likely cause if you see this in the wild: the migration at
 * prisma/admin/migrations/20260429300000_add_salary_tables hasn't
 * run yet AND the auto-heal in ensureSalarySchema() also failed
 * (e.g. the running DB user can't CREATE TABLE). The error.digest
 * shown below is what Vercel logs match against.
 *
 * SECURITY: the raw `error.message` is never rendered — only the digest
 * (safe correlation handle) is shown. Full stack lives in server logs.
 */
export default function SalariesError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[salaries] page error boundary caught:", error);
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
              Salaries unavailable
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              The salaries page failed to load. The error was logged — most
              transient failures clear on a retry.
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
        <p className="text-sm font-medium text-amber-700 dark:text-amber-300">
          Likely cause
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          The salary tables aren&apos;t initialized in the admin DB yet. The
          page tries to auto-create them on first load — if that&apos;s
          failing, run the migration manually:
        </p>
        <pre className="mt-2 whitespace-pre-wrap rounded-md bg-muted p-2 font-mono text-[11px]">
          npx prisma db execute --file=./prisma/admin/migrations/20260429300000_add_salary_tables/migration.sql --config=prisma/admin/prisma.config.ts
        </pre>
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
