import {
  getAntifraudEventCatalog,
  getAntifraudScoringConfig,
} from "@/lib/antifraud/monitor-api";
import { FlowBuilder } from "../../flows/flow-builder";
import { Unavailable } from "./shared";

/** FLOWS TAB — the point-flow builder, the one full editor on this page. */
export async function FlowsSection() {
  const [scoring, events] = await Promise.all([
    getAntifraudScoringConfig(),
    getAntifraudEventCatalog(),
  ]);
  if (!scoring.configured || !events.configured) {
    return <Unavailable text="The monitor service is not configured." />;
  }
  if (scoring.error || events.error || !scoring.data) {
    return (
      <Unavailable text="The flow builder could not load the live monitor configuration." />
    );
  }
  return (
    <FlowBuilder
      initialRules={scoring.data.behaviorRules}
      events={events.data}
      monitorWindowSeconds={scoring.data.monitorDurationSeconds}
    />
  );
}
