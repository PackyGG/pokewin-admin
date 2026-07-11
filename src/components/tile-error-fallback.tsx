import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * TileErrorFallback — small server-component-safe fallback to drop in
 * place of a single failed sub-tile inside a larger composition
 * (KPI strip, dashboard row, sidebar panel).
 *
 * Visual contract:
 *   • Same shape + padding family as KpiTile / StatPanel so the layout
 *     doesn't shift when a tile flips to its error state.
 *   • Calm amber accent — visible enough that the admin notices, but
 *     not the screaming rose used by the route-level error boundary
 *     (one degraded tile is not a page crash).
 *   • No CTA buttons inside — the surrounding context (the dashboard's
 *     AutoRefresh, the page-level "Try again", a sidebar refresh) is
 *     where retries actually live.
 *
 * Usage — replace one tile in a Promise.all-fed grid:
 *
 *   const { data, error } = await safeQuery(getThing, null, "x.tile");
 *   {error ? <TileErrorFallback label="Thing" /> : <KpiTile {...data} />}
 *
 * Or inside a Suspense boundary as the catch-all when a deferred tile's
 * own async work threw:
 *
 *   <Suspense fallback={<KpiTileSkeleton />}>
 *     <Tile />        // internally calls safeQuery
 *   </Suspense>
 *
 * `label` is the short tile name ("Total Users", "Treasury", …). The
 * generic "Couldn't load" copy below it is intentional — never echo a
 * raw error message into the DOM (see SECURITY note in safe-query.ts).
 *
 * `size` lets the same fallback drop into a KPI strip (`compact`) or
 * a full StatPanel slot (`panel`) without two separate components.
 * Defaults to `compact` because that's the more common slot.
 */
export function TileErrorFallback({
  label,
  hint,
  kind,
  size = "compact",
  className,
}: {
  /** Short tile name — shows above the error message. */
  label: string;
  /** Optional one-line hint shown below the headline. Never a raw error. */
  hint?: string;
  /**
   * Why the tile degraded — drives truthful headline copy:
   *   • "timeout" → the query was merely SLOW (a `safeQuery` timeoutMs race
   *     fired); "Taking too long to load" invites a refresh-retry.
   *   • "error" / omitted → a hard failure; the generic "Couldn't load" copy.
   * A serializable string enum (NEVER a function or the raw error object) so
   * it crosses the Server→Client RSC boundary safely. The matching
   * `SafeQueryResult.kind` can be passed straight through.
   */
  kind?: "timeout" | "error";
  /** Visual shape — matches KpiTile (compact) or StatPanel (panel). */
  size?: "compact" | "panel";
  className?: string;
}) {
  // Match the surface family but tinted amber so the degraded state
  // stands out from healthy KpiTiles. Padding and radius track the
  // primitive each variant replaces so the surrounding grid doesn't
  // jump on partial failure.
  const isPanel = size === "panel";
  // Caller-controlled, static copy only — never interpolate a raw error
  // message. The timeout branch is reachable once a `timeoutMs` is wired.
  const headline =
    kind === "timeout"
      ? "Taking too long to load"
      : "Couldn't load this section";
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "relative overflow-hidden border border-amber-500/30 bg-amber-500/10",
        isPanel ? "rounded-xl p-4 sm:p-5" : "rounded-lg px-3 py-2.5 sm:px-4 sm:py-3",
        className,
      )}
    >
      <div className="relative flex items-start gap-2">
        <AlertTriangle
          aria-hidden
          className={cn(
            "mt-0.5 shrink-0 text-amber-500",
            isPanel ? "size-4" : "size-3.5",
          )}
        />
        <div className="min-w-0 flex-1">
          <p
            className={cn(
              "truncate font-semibold uppercase tracking-wider text-muted-foreground",
              isPanel ? "text-xs" : "text-[10px] sm:text-[11px]",
            )}
          >
            {label}
          </p>
          <p
            className={cn(
              "mt-1 text-amber-700 dark:text-amber-300",
              isPanel
                ? "text-sm font-medium"
                : "text-xs font-medium",
            )}
          >
            {headline}
          </p>
          {hint && (
            <p
              className={cn(
                "mt-0.5 text-muted-foreground",
                isPanel ? "text-xs" : "text-[10px] sm:text-[11px]",
              )}
            >
              {hint}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
