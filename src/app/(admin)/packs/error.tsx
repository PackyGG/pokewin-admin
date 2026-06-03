"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, RotateCw, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHero } from "@/components/modern-panels";

/**
 * Route-level error boundary for /packs.
 *
 * Packs is the content tree — pack definitions + card pool composition.
 * A failure here is almost always a stale Prisma field (the cards
 * sub-tree migrated faster than the packs queries) or a transient
 * timeout on the cached KPI strip. The reset path re-runs the page's
 * server render without a full reload, which fixes most transient
 * failures.
 */
export default function PacksError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[packs] page error boundary caught:", error);
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
              Couldn&apos;t load packs
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              The packs query failed while rendering. The error was
              logged — no pack definition was modified by this error.
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
          Pack definitions live in the main DB and are read-only on
          this page — nothing destructive happens on a render failure.
          Server logs (matched by the digest above) have the stack.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Button type="button" variant="default" size="sm" onClick={reset}>
          <RotateCw className="size-4" />
          Try again
        </Button>
        <Button variant="outline" size="sm" render={<Link href="/dashboard" />}>
          <ArrowLeft className="size-4" />
          Back to dashboard
        </Button>
      </div>
    </div>
  );
}
