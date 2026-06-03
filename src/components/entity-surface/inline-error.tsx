"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * ──────────────────────────────────────────────────────────────────────────
 *  InlineError  (pokewin-admin · src/components/entity-surface)
 * ──────────────────────────────────────────────────────────────────────────
 *
 * A non-blocking inline error block for a list/section that failed to load —
 * the operator stays on the page and can retry, instead of being thrown to the
 * route-level error boundary or (never) an `alert()`. Pairs with `safeQuery`:
 * when a primary list query returns an `error`, render this in place of the
 * table/grid.
 *
 * Contract:
 *   - `role="status"` + polite live region (an assistive-tech user hears the
 *     failure once).
 *   - Calm amber accent (a degraded section, not a screaming page crash) —
 *     matches `TileErrorFallback`.
 *   - A real Retry BUTTON. Default retry is `router.refresh()` (re-runs the
 *     server segment that owns the failing query); pass `onRetry` to override
 *     (e.g. a client refetch). NEVER an `alert()`.
 *   - NEVER echoes a raw error message into the DOM — copy is generic; the real
 *     error is already logged server-side by `safeQuery` (see its SECURITY
 *     note). An optional `hint` may give safe, non-sensitive guidance.
 */
export function InlineError({
  title = "Couldn't load this section",
  hint,
  onRetry,
  retryLabel = "Retry",
  compact = false,
  className,
}: {
  title?: string;
  /** Safe, non-sensitive guidance. Never a raw error message. */
  hint?: string;
  /** Override the default `router.refresh()` retry. */
  onRetry?: () => void;
  retryLabel?: string;
  compact?: boolean;
  className?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();

  const handleRetry = React.useCallback(() => {
    if (onRetry) {
      onRetry();
      return;
    }
    startTransition(() => router.refresh());
  }, [onRetry, router]);

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] text-center",
        compact ? "px-4 py-8" : "px-6 py-12 sm:py-16",
        className,
      )}
    >
      <div
        className={cn(
          "flex items-center justify-center rounded-xl border border-amber-500/30 bg-amber-500/10",
          compact ? "size-9" : "size-12",
        )}
      >
        <AlertTriangle
          aria-hidden
          className={cn("text-amber-500", compact ? "size-4" : "size-6")}
        />
      </div>
      <div className="space-y-1">
        <p className={cn("font-semibold", compact ? "text-sm" : "text-sm sm:text-base")}>
          {title}
        </p>
        {hint && (
          <p className="mx-auto max-w-sm text-xs text-muted-foreground sm:text-sm">
            {hint}
          </p>
        )}
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={handleRetry}
        disabled={pending}
        className="mt-1"
      >
        <RefreshCw className={cn("size-3.5", pending && "animate-spin")} />
        {retryLabel}
      </Button>
    </div>
  );
}
