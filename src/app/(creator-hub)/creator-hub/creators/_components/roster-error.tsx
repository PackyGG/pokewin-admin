import { AlertTriangle } from "lucide-react";

/**
 * Roster error card — shown when the backend creator-roster walk itself
 * fails (the page can't list creators). Mirrors the legacy /creators error
 * affordance: a clear headline + hint, never the raw error message. Server-
 * safe (no props, no client boundary needed).
 */
export function RosterError() {
  return (
    <div className="rounded-2xl border border-rose-500/30 bg-rose-500/5 p-4">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-rose-500" />
        <div className="space-y-1">
          <p className="text-sm font-semibold text-rose-500 dark:text-rose-400">
            Could not load the creator roster
          </p>
          <p className="text-xs text-muted-foreground">
            The packy.gg backend didn&apos;t respond, so the roster is
            temporarily unavailable. Reload once the backend is reachable.
          </p>
        </div>
      </div>
    </div>
  );
}
