"use client";

import Link from "next/link";
import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useHostHref } from "@/lib/use-app-host";

/**
 * HubErrorPage — the ONE segment-level error body for Creator Hub routes.
 *
 * Every `error.tsx` under the Hub renders this with its own copy instead of
 * duplicating the rose-chip + explainer + actions layout per route (the
 * leaderboards and tips-sponsors boundaries used to be near-verbatim copies).
 *
 * Security: never echoes `error.message` (it can carry backend internals) —
 * only the opaque `digest` for support correlation.
 */
export function HubErrorPage({
  title,
  detail,
  digest,
  reset,
  backHref = "/creator-hub",
  backLabel = "Back to dashboard",
}: {
  title: string;
  /** One plain-English sentence on what this page needs to load. */
  detail: string;
  digest?: string;
  reset: () => void;
  backHref?: string;
  backLabel?: string;
}) {
  // Host-aware: `/creator-hub` on the apex, `/` on marketing.packydash.com.
  const resolvedBackHref = useHostHref(backHref);
  return (
    <div className="mx-auto max-w-2xl space-y-4 py-8">
      <div className="rounded-xl border bg-card p-5">
        <div className="flex items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-rose-500/10">
            <AlertTriangle className="size-4 text-rose-500" aria-hidden />
          </div>
          <div className="min-w-0 space-y-1">
            <h1 className="text-sm font-semibold">{title}</h1>
            <p className="text-xs text-muted-foreground">{detail}</p>
            {digest && (
              <p className="text-[11px] text-muted-foreground/70">
                Reference: <span className="font-mono">{digest}</span>
              </p>
            )}
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={reset}>
            Try again
          </Button>
          <Button
            size="sm"
            variant="outline"
            nativeButton={false}
            render={<Link href={resolvedBackHref} />}
          >
            {backLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
