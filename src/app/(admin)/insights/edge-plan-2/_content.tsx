import { getEdgePlanV2Baseline } from "./_baseline-v2";
import { EdgePlanV2Planner } from "./_planner/planner-shell";

export async function EdgePlanV2Content() {
  const baseline = await getEdgePlanV2Baseline();
  return <EdgePlanV2Planner baseline={baseline} />;
}
