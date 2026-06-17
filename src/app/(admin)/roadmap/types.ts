// Shared types + display metadata for the Roadmap feature. Imported by both
// the calendar surface and the feature-detail surface (and the server
// actions). All dates cross the server→client boundary as ISO strings.

export const ROADMAP_STATUSES = [
  "planned",
  "in_progress",
  "shipped",
  "blocked",
  "cancelled",
] as const;
export type RoadmapStatus = (typeof ROADMAP_STATUSES)[number];

export const ROADMAP_STATUS_META: Record<
  RoadmapStatus,
  { label: string; badge: string; dot: string }
> = {
  planned: {
    label: "Planned",
    badge:
      "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
    dot: "bg-blue-500",
  },
  in_progress: {
    label: "In progress",
    badge:
      "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
    dot: "bg-amber-500",
  },
  shipped: {
    label: "Shipped",
    badge:
      "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
    dot: "bg-emerald-500",
  },
  blocked: {
    label: "Blocked",
    badge:
      "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30",
    dot: "bg-rose-500",
  },
  cancelled: {
    label: "Cancelled",
    badge: "bg-muted text-muted-foreground border-border",
    dot: "bg-muted-foreground",
  },
};

// Accent tokens — a subset of the modern-panels TILE_COLORS keys.
export const ROADMAP_COLORS = [
  "blue",
  "emerald",
  "rose",
  "cyan",
  "amber",
  "purple",
  "orange",
  "pink",
] as const;
export type RoadmapColor = (typeof ROADMAP_COLORS)[number];

export function isRoadmapColor(v: string | null): v is RoadmapColor {
  return v != null && (ROADMAP_COLORS as readonly string[]).includes(v);
}

export type RoadmapItemSummary = {
  id: string;
  title: string;
  description: string | null;
  status: RoadmapStatus;
  /** ISO timestamp (UTC midnight of the block's first day), or null when the
   *  item is an unscheduled backlog idea. */
  startDate: string | null;
  /** ISO timestamp (UTC midnight of the block's last, inclusive day), or null
   *  when unscheduled. */
  endDate: string | null;
  color: RoadmapColor | null;
  linearCount: number;
};

export type RoadmapDetailField = { id: string; label: string; value: string };

export type RoadmapLink = { id: string; label: string; url: string };

export type RoadmapLinearLink = {
  id: string;
  issueId: string;
  identifier: string;
  title: string;
  url: string;
  stateName: string | null;
  stateType: string | null;
  stateColor: string | null;
  assigneeName: string | null;
  syncedAt: string;
};

export type RoadmapItemDetail = RoadmapItemSummary & {
  body: string | null;
  detailFields: RoadmapDetailField[];
  links: RoadmapLink[];
  linearLinks: RoadmapLinearLink[];
};

export type ActionResult<T = undefined> =
  | ({ success: true } & (T extends undefined ? object : { data: T }))
  | { success: false; error: string };
