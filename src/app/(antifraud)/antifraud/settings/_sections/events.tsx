import { getAntifraudEventCatalog } from "@/lib/antifraud/monitor-api";
import { PanelErrorBoundary } from "../../_components/panel-error-boundary";
import { EventCatalog } from "../../events/event-catalog";
import { Unavailable } from "./shared";

/**
 * EVENTS TAB — the canonical live and planned event vocabulary point flows are
 * built from. Read-only: the catalog is owned by the monitor service.
 */
export async function EventsSection() {
  const result = await getAntifraudEventCatalog();
  if (!result.configured) {
    return <Unavailable text="The monitor service is not configured." />;
  }
  if (result.error) {
    return <Unavailable text="The event catalog could not be loaded." />;
  }
  return (
    <PanelErrorBoundary label="Event catalog">
      <EventCatalog events={result.data} />
    </PanelErrorBoundary>
  );
}
