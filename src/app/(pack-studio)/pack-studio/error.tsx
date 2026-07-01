"use client";

import { useEffect } from "react";
import { AlertTriangle, RotateCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { PageHero } from "@/components/modern-panels";

/**
 * Group-level error boundary for the whole `/pack-studio` sub-app.
 *
 * Renders INSIDE the Pack Studio shell (the layout above survives), so an
 * uncaught throw from any Studio surface — the operator-access gate, an
 * ADMIN-DB read, or the MAIN read-only pack-meta join — no longer
 * white-screens into the umbrella/root boundary. The operator keeps the
 * Studio sidebar + header and gets a retry that re-renders just this
 * segment. Mirrors `src/app/(admin)/error.tsx` and
 * `src/app/(creator-hub)/creator-hub/acquisition/error.tsx`.
 *
 * Per-route boundaries (builder / doctor / cards / history / drafts / retune)
 * sit BELOW this one for surface-specific copy + a back link that keeps the
 * operator in the Studio; this is the last line for anything that escapes
 * them (or throws in the overview itself).
 *
 * SAFETY: nothing here writes MAIN. Every Studio MAIN write is a separate,
 * 2FA-guarded, confirm-dialog action — a render/read failure caught here
 * never mutated prod. `reset()` just re-runs the failed server render.
 *
 * SECURITY: `error.message` is intentionally NOT rendered — never echo a
 * raw upstream error into the DOM. The digest is the safe correlation
 * handle.
 */
export default function PackStudioError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[pack-studio] error boundary caught:", error);
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
              Couldn&apos;t load Pack Studio
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              A Studio query failed before this surface could render. The
              error was logged — try again, or head back to the Studio
              overview.
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
          Pack definitions + card pools live in the main DB and are read-only
          on every Studio surface — no pack was modified by this error (the
          only writes are the 2FA-guarded push / retune / revert actions,
          which never run on a render failure). Server logs (matched by the
          digest above) carry the full stack.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Button type="button" variant="default" size="sm" onClick={reset}>
          <RotateCw className="size-4" />
          Try again
        </Button>
      </div>
    </div>
  );
}
