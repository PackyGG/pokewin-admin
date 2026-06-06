/** Client-safe window selector constants for Deal Tracker. */

export type DealTrackerWindow = "14d" | "30d" | "60d" | "90d";

export const DEAL_TRACKER_WINDOWS: readonly {
  value: DealTrackerWindow;
  label: string;
  days: number;
}[] = [
  { value: "14d", label: "14 days", days: 14 },
  { value: "30d", label: "30 days", days: 30 },
  { value: "60d", label: "60 days", days: 60 },
  { value: "90d", label: "90 days", days: 90 },
];

export function parseDealTrackerWindow(
  raw: string | undefined,
): DealTrackerWindow {
  return DEAL_TRACKER_WINDOWS.some((w) => w.value === raw)
    ? (raw as DealTrackerWindow)
    : "30d";
}

export function dealTrackerWindowDays(window: DealTrackerWindow): number {
  return DEAL_TRACKER_WINDOWS.find((w) => w.value === window)?.days ?? 30;
}
