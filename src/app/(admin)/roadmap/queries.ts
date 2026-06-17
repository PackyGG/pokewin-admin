import { adminDb } from "@/lib/admin-db";
import {
  isRoadmapColor,
  type RoadmapColor,
  type RoadmapItemDetail,
  type RoadmapItemSummary,
  type RoadmapStatus,
} from "./types";

function toColor(c: string | null): RoadmapColor | null {
  return isRoadmapColor(c) ? c : null;
}

/** All active (non-archived) roadmap items, ordered for the calendar.
 *  Admin-DB only — never touches the MAIN game DB. */
export async function getRoadmapItems(): Promise<RoadmapItemSummary[]> {
  const rows = await adminDb.roadmap_items.findMany({
    where: { archived_at: null },
    // sort_order drives the manual backlog ordering; the calendar positions
    // scheduled items by date and ignores this ordering.
    orderBy: [{ sort_order: "asc" }, { created_at: "asc" }],
    select: {
      id: true,
      title: true,
      description: true,
      status: true,
      start_date: true,
      end_date: true,
      color: true,
      _count: { select: { linear_links: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    status: r.status as RoadmapStatus,
    startDate: r.start_date?.toISOString() ?? null,
    endDate: r.end_date?.toISOString() ?? null,
    color: toColor(r.color),
    linearCount: r._count.linear_links,
  }));
}

/** Full detail for one item (fields, links, attached Linear issues).
 *  Returns null when missing or archived. */
export async function getRoadmapItem(
  id: string,
): Promise<RoadmapItemDetail | null> {
  const r = await adminDb.roadmap_items.findUnique({
    where: { id },
    include: {
      detail_fields: { orderBy: [{ sort_order: "asc" }, { created_at: "asc" }] },
      links: { orderBy: [{ sort_order: "asc" }, { created_at: "asc" }] },
      linear_links: { orderBy: { created_at: "asc" } },
    },
  });
  if (!r || r.archived_at) return null;
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    status: r.status as RoadmapStatus,
    startDate: r.start_date?.toISOString() ?? null,
    endDate: r.end_date?.toISOString() ?? null,
    color: toColor(r.color),
    body: r.body,
    linearCount: r.linear_links.length,
    detailFields: r.detail_fields.map((f) => ({
      id: f.id,
      label: f.label,
      value: f.value,
    })),
    links: r.links.map((l) => ({ id: l.id, label: l.label, url: l.url })),
    linearLinks: r.linear_links.map((l) => ({
      id: l.id,
      issueId: l.linear_issue_id,
      identifier: l.identifier,
      title: l.title,
      url: l.url,
      stateName: l.state_name,
      stateType: l.state_type,
      stateColor: l.state_color,
      assigneeName: l.assignee_name,
      syncedAt: l.synced_at.toISOString(),
    })),
  };
}
