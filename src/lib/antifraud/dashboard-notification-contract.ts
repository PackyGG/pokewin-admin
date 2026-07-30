export const ANTIFRAUD_DASHBOARD_GROUPS = [
  "owner",
  "admin",
  "support",
  "marketing",
  "creator_manager",
  "creator",
  "pack_creator",
] as const;

export const ANTIFRAUD_SEVERITIES = [
  "low",
  "medium",
  "high",
  "critical",
] as const;

export type AntifraudDashboardGroup =
  (typeof ANTIFRAUD_DASHBOARD_GROUPS)[number];
export type AntifraudSeverity = (typeof ANTIFRAUD_SEVERITIES)[number];

export type AntifraudDashboardNotificationRule = {
  id: string;
  eventKey: string;
  eventLabel: string;
  label: string;
  minimumSeverity: AntifraudSeverity;
  targetGroups: AntifraudDashboardGroup[];
  titleTemplate: string;
  bodyTemplate: string;
  hrefTemplate: string | null;
  enabled: boolean;
  updatedAt: string;
};

export type AntifraudDashboardEventOption = {
  key: string;
  label: string;
  category: string;
};
