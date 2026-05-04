"use client";

import { useEffect } from "react";
import { AlertTriangle, RotateCw } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { PageHero } from "@/components/modern-panels";

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
 */
export default function SalariesError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error("[salaries] page error:", error);
  }, [error]);

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-rose-500/10">
            <AlertTriangle className="size-5 text-rose-500" />
          </div>
          <div>
            <h1 className="text-2xl font-bold leading-tight">
              Salaries unavailable
            </h1>
            <p className="text-sm text-muted-foreground">
              The salaries page failed to load. The error has been
              logged.
            </p>
          </div>
        </div>
      </PageHero>

      <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
        <p className="text-sm text-amber-700 dark:text-amber-300 font-medium">
          Likely cause
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          The salary tables aren&apos;t initialized in the admin DB
          yet. The page tries to auto-create them on first load — if
          that&apos;s failing, run the migration manually:
        </p>
        <pre className="mt-2 rounded-md bg-muted p-2 text-[11px] font-mono whitespace-pre-wrap">
          npx prisma db execute --file=./prisma/admin/migrations/20260429300000_add_salary_tables/migration.sql --config=prisma/admin/prisma.config.ts
        </pre>
      </div>

      <div className="flex items-center gap-2">
        <Button onClick={() => reset()}>
          <RotateCw className="size-4" />
          Try again
        </Button>
        <Button variant="outline" render={<Link href="/dashboard">Go home</Link>} />
      </div>

      {error.digest && (
        <p className="text-[11px] text-muted-foreground font-mono">
          digest: {error.digest}
        </p>
      )}
    </div>
  );
}
