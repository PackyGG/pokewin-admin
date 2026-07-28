import { AlertTriangle } from "lucide-react";

import { HubNotice } from "../../_components/hub-notice";

/**
 * Roster error card — shown when the backend creator-roster walk itself
 * fails (the page can't list creators). Uses the shared `HubNotice` rose
 * tone: a clear headline + hint, never the raw error message. Server-safe.
 */
export function RosterError() {
  return (
    <HubNotice
      tone="rose"
      icon={AlertTriangle}
      title="Could not load the creator roster"
    >
      The packy.gg backend didn&apos;t respond, so the roster is temporarily
      unavailable. Reload once the backend is reachable.
    </HubNotice>
  );
}
