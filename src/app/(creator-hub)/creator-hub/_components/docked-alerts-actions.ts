"use server";

import { requireCreatorHubAccess } from "@/lib/require-creator-hub-access";
import {
  getCreatorAlerts,
  type CreatorAlertsResult,
} from "../alerts/_queries/creator-alerts";

/**
 * Server action for the docked Alerts widget. Auth gate matches the
 * former `/creator-hub/alerts` page — Hub access only.
 */
export async function fetchDockedAlerts(): Promise<CreatorAlertsResult> {
  await requireCreatorHubAccess();
  return getCreatorAlerts();
}
