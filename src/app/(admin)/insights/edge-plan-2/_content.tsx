import { AlertTriangle } from "lucide-react";

import { getEdgePlanV2Baseline } from "./_baseline-v2";
import { EdgePlanV2Planner } from "./_planner/planner-shell";

export async function EdgePlanV2Content() {
  const result = await getEdgePlanV2Baseline();

  if (!result.ok) {
    // Critical baseline legs failed. NOTHING was cached (do-not-cache-
    // failures), so a reload re-runs the build — render an explicit error
    // band with a retry instead of a dead all-zeros planner.
    return (
      <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-4">
        <p className="flex items-center gap-2 text-sm font-semibold text-rose-700 dark:text-rose-300">
          <AlertTriangle className="size-4" aria-hidden />
          Edge Plan baseline unavailable
        </p>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          {result.reason}
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          The failed result was <span className="font-medium text-foreground">not cached</span>{" "}
          —{" "}
          <a
            href="/insights/edge-plan-2"
            className="font-medium text-foreground underline underline-offset-2"
          >
            reload the page
          </a>{" "}
          to retry immediately.
        </p>
      </div>
    );
  }

  return <EdgePlanV2Planner baseline={result.baseline} />;
}
