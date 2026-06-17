"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { adminDb } from "@/lib/admin-db";
import { requirePageAccess } from "@/lib/dal";
import { requireOwner } from "@/lib/owners";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import {
  createLinearIssue,
  getLinearIssues,
  listLinearTeams,
  searchLinearIssues,
  type LinearIssue,
  type LinearTeam,
} from "@/lib/linear";
import { ROADMAP_COLORS, ROADMAP_STATUSES, type ActionResult } from "./types";

const PAGE_KEY = "/roadmap";

function fail(error: string): { success: false; error: string } {
  return { success: false, error };
}

function revalidateItem(itemId?: string) {
  revalidatePath(PAGE_KEY);
  if (itemId) revalidatePath(`${PAGE_KEY}/${itemId}`);
}

// Date-only string (YYYY-MM-DD) → UTC-midnight Date. Keeps calendar math
// timezone-stable (a block's day never drifts across the date line).
const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

function toUtcMidnight(d: string): Date {
  return new Date(`${d}T00:00:00.000Z`);
}

const itemCreateSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(200),
  description: z.string().trim().max(2000).nullish(),
  status: z.enum(ROADMAP_STATUSES),
  // Both present → scheduled on the calendar. Both absent → backlog idea.
  startDate: dateOnly.optional(),
  endDate: dateOnly.optional(),
  color: z.enum(ROADMAP_COLORS).nullish(),
});

const itemUpdateSchema = itemCreateSchema.extend({
  id: z.string().uuid(),
});

const reorderSchema = z.object({
  ids: z.array(z.string().uuid()).min(1),
});

const BOTH_OR_NEITHER =
  "Provide both a start and end date, or leave both empty to keep it in the backlog";

// Resolve the optional date pair into UTC-midnight Dates (or nulls for a
// backlog item). Returns an error string when only one date is supplied or
// the range is inverted.
function resolveDates(
  startDate?: string,
  endDate?: string,
): { start: Date | null; end: Date | null } | { error: string } {
  const hasStart = !!startDate;
  const hasEnd = !!endDate;
  if (hasStart !== hasEnd) return { error: BOTH_OR_NEITHER };
  if (!hasStart) return { start: null, end: null };
  const start = toUtcMidnight(startDate!);
  const end = toUtcMidnight(endDate!);
  const rangeErr = validateRange(start, end);
  if (rangeErr) return { error: rangeErr };
  return { start, end };
}

const moveSchema = z.object({
  id: z.string().uuid(),
  startDate: dateOnly,
  endDate: dateOnly,
});

function validateRange(start: Date, end: Date): string | null {
  if (end < start) return "End date must be on or after the start date";
  return null;
}

// ── Item CRUD ───────────────────────────────────────────────────────

export async function createRoadmapItem(
  input: z.infer<typeof itemCreateSchema>,
): Promise<ActionResult<{ id: string }>> {
  const session = await requirePageAccess(PAGE_KEY);
  const parsed = itemCreateSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input");
  const d = parsed.data;
  const dates = resolveDates(d.startDate, d.endDate);
  if ("error" in dates) return fail(dates.error);

  // Backlog ideas append to the end of the manual order.
  let sortOrder = 0;
  if (!dates.start) {
    const max = await adminDb.roadmap_items.aggregate({
      where: { archived_at: null, start_date: null },
      _max: { sort_order: true },
    });
    sortOrder = (max._max.sort_order ?? -1) + 1;
  }

  const row = await adminDb.roadmap_items.create({
    data: {
      title: d.title,
      description: d.description ?? null,
      status: d.status,
      start_date: dates.start,
      end_date: dates.end,
      color: d.color ?? null,
      sort_order: sortOrder,
      created_by: session.userId,
    },
    select: { id: true },
  });
  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "roadmap_item_created",
    metadata: { itemId: row.id, title: d.title },
  });
  revalidateItem(row.id);
  return { success: true, data: { id: row.id } };
}

export async function updateRoadmapItem(
  input: z.infer<typeof itemUpdateSchema>,
): Promise<ActionResult> {
  const session = await requirePageAccess(PAGE_KEY);
  const parsed = itemUpdateSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input");
  const d = parsed.data;
  const dates = resolveDates(d.startDate, d.endDate);
  if ("error" in dates) return fail(dates.error);

  await adminDb.roadmap_items.update({
    where: { id: d.id },
    data: {
      title: d.title,
      description: d.description ?? null,
      status: d.status,
      start_date: dates.start,
      end_date: dates.end,
      color: d.color ?? null,
    },
  });
  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "roadmap_item_updated",
    metadata: { itemId: d.id },
  });
  revalidateItem(d.id);
  return { success: true };
}

export async function moveRoadmapItem(
  input: z.infer<typeof moveSchema>,
): Promise<ActionResult> {
  await requirePageAccess(PAGE_KEY);
  const parsed = moveSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input");
  const d = parsed.data;
  const start = toUtcMidnight(d.startDate);
  const end = toUtcMidnight(d.endDate);
  const rangeErr = validateRange(start, end);
  if (rangeErr) return fail(rangeErr);

  await adminDb.roadmap_items.update({
    where: { id: d.id },
    data: { start_date: start, end_date: end },
  });
  revalidateItem(d.id);
  return { success: true };
}

/** Persist the manual ordering of backlog ideas. `ids` is the full backlog in
 *  its new top-to-bottom order; each row's sort_order becomes its index. */
export async function reorderBacklog(
  input: z.infer<typeof reorderSchema>,
): Promise<ActionResult> {
  await requirePageAccess(PAGE_KEY);
  const parsed = reorderSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input");
  await adminDb.$transaction(
    parsed.data.ids.map((id, idx) =>
      adminDb.roadmap_items.update({
        where: { id },
        data: { sort_order: idx },
      }),
    ),
  );
  revalidateItem();
  return { success: true };
}

export async function archiveRoadmapItem(id: string): Promise<ActionResult> {
  const session = await requirePageAccess(PAGE_KEY);
  if (!z.string().uuid().safeParse(id).success) return fail("Invalid id");
  await adminDb.roadmap_items.update({
    where: { id },
    data: { archived_at: new Date() },
  });
  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "roadmap_item_archived",
    metadata: { itemId: id },
  });
  revalidateItem(id);
  return { success: true };
}

const bodySchema = z.object({
  id: z.string().uuid(),
  body: z.string().max(20000).nullish(),
});

export async function updateRoadmapBody(
  input: z.infer<typeof bodySchema>,
): Promise<ActionResult> {
  await requirePageAccess(PAGE_KEY);
  const parsed = bodySchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input");
  await adminDb.roadmap_items.update({
    where: { id: parsed.data.id },
    data: { body: parsed.data.body?.trim() || null },
  });
  revalidateItem(parsed.data.id);
  return { success: true };
}

// ── Detail fields ───────────────────────────────────────────────────

const fieldAddSchema = z.object({
  itemId: z.string().uuid(),
  label: z.string().trim().min(1, "Label is required").max(80),
  value: z.string().trim().max(500),
});
const fieldUpdateSchema = z.object({
  id: z.string().uuid(),
  label: z.string().trim().min(1, "Label is required").max(80),
  value: z.string().trim().max(500),
});

export async function addRoadmapDetailField(
  input: z.infer<typeof fieldAddSchema>,
): Promise<ActionResult> {
  await requirePageAccess(PAGE_KEY);
  const parsed = fieldAddSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input");
  const count = await adminDb.roadmap_detail_fields.count({
    where: { item_id: parsed.data.itemId },
  });
  await adminDb.roadmap_detail_fields.create({
    data: {
      item_id: parsed.data.itemId,
      label: parsed.data.label,
      value: parsed.data.value,
      sort_order: count,
    },
  });
  revalidateItem(parsed.data.itemId);
  return { success: true };
}

export async function updateRoadmapDetailField(
  input: z.infer<typeof fieldUpdateSchema>,
): Promise<ActionResult> {
  await requirePageAccess(PAGE_KEY);
  const parsed = fieldUpdateSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input");
  const row = await adminDb.roadmap_detail_fields.update({
    where: { id: parsed.data.id },
    data: { label: parsed.data.label, value: parsed.data.value },
    select: { item_id: true },
  });
  revalidateItem(row.item_id);
  return { success: true };
}

export async function removeRoadmapDetailField(
  id: string,
): Promise<ActionResult> {
  await requirePageAccess(PAGE_KEY);
  if (!z.string().uuid().safeParse(id).success) return fail("Invalid id");
  const row = await adminDb.roadmap_detail_fields.delete({
    where: { id },
    select: { item_id: true },
  });
  revalidateItem(row.item_id);
  return { success: true };
}

// ── Links ───────────────────────────────────────────────────────────

const linkAddSchema = z.object({
  itemId: z.string().uuid(),
  label: z.string().trim().min(1, "Label is required").max(120),
  url: z.string().trim().url("Enter a valid URL").max(2000),
});
const linkUpdateSchema = z.object({
  id: z.string().uuid(),
  label: z.string().trim().min(1, "Label is required").max(120),
  url: z.string().trim().url("Enter a valid URL").max(2000),
});

export async function addRoadmapLink(
  input: z.infer<typeof linkAddSchema>,
): Promise<ActionResult> {
  await requirePageAccess(PAGE_KEY);
  const parsed = linkAddSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input");
  const count = await adminDb.roadmap_links.count({
    where: { item_id: parsed.data.itemId },
  });
  await adminDb.roadmap_links.create({
    data: {
      item_id: parsed.data.itemId,
      label: parsed.data.label,
      url: parsed.data.url,
      sort_order: count,
    },
  });
  revalidateItem(parsed.data.itemId);
  return { success: true };
}

export async function updateRoadmapLink(
  input: z.infer<typeof linkUpdateSchema>,
): Promise<ActionResult> {
  await requirePageAccess(PAGE_KEY);
  const parsed = linkUpdateSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input");
  const row = await adminDb.roadmap_links.update({
    where: { id: parsed.data.id },
    data: { label: parsed.data.label, url: parsed.data.url },
    select: { item_id: true },
  });
  revalidateItem(row.item_id);
  return { success: true };
}

export async function removeRoadmapLink(id: string): Promise<ActionResult> {
  await requirePageAccess(PAGE_KEY);
  if (!z.string().uuid().safeParse(id).success) return fail("Invalid id");
  const row = await adminDb.roadmap_links.delete({
    where: { id },
    select: { item_id: true },
  });
  revalidateItem(row.item_id);
  return { success: true };
}

// ── Linear (read: page-access; write/create: owner only) ─────────────

export async function searchLinearIssuesAction(
  term: string,
  teamKey?: string,
): Promise<ActionResult<LinearIssue[]>> {
  await requirePageAccess(PAGE_KEY);
  try {
    const issues = await searchLinearIssues(term, teamKey);
    return { success: true, data: issues };
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Linear search failed");
  }
}

export async function listLinearTeamsAction(): Promise<
  ActionResult<LinearTeam[]>
> {
  await requirePageAccess(PAGE_KEY);
  try {
    return { success: true, data: await listLinearTeams() };
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Failed to load teams");
  }
}

const attachSchema = z.object({
  itemId: z.string().uuid(),
  issueId: z.string().min(1),
});

/** Attach an existing Linear issue. Re-fetches authoritative data from
 *  Linear by id and stores a snapshot for fast/offline rendering. */
export async function attachLinearIssue(
  input: z.infer<typeof attachSchema>,
): Promise<ActionResult> {
  const session = await requirePageAccess(PAGE_KEY);
  const parsed = attachSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input");
  try {
    const map = await getLinearIssues([parsed.data.issueId]);
    const issue = map.get(parsed.data.issueId);
    if (!issue) return fail("Linear issue not found");
    await adminDb.roadmap_linear_links.upsert({
      where: {
        item_id_linear_issue_id: {
          item_id: parsed.data.itemId,
          linear_issue_id: issue.id,
        },
      },
      create: {
        item_id: parsed.data.itemId,
        linear_issue_id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        url: issue.url,
        state_name: issue.stateName,
        state_type: issue.stateType,
        state_color: issue.stateColor,
        assignee_name: issue.assigneeName,
      },
      update: {
        identifier: issue.identifier,
        title: issue.title,
        url: issue.url,
        state_name: issue.stateName,
        state_type: issue.stateType,
        state_color: issue.stateColor,
        assignee_name: issue.assigneeName,
        synced_at: new Date(),
      },
    });
    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "roadmap_linear_attached",
      metadata: { itemId: parsed.data.itemId, identifier: issue.identifier },
    });
    revalidateItem(parsed.data.itemId);
    return { success: true };
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Failed to attach issue");
  }
}

export async function detachLinearIssue(id: string): Promise<ActionResult> {
  const session = await requirePageAccess(PAGE_KEY);
  if (!z.string().uuid().safeParse(id).success) return fail("Invalid id");
  const row = await adminDb.roadmap_linear_links.delete({
    where: { id },
    select: { item_id: true, identifier: true },
  });
  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "roadmap_linear_detached",
    metadata: { itemId: row.item_id, identifier: row.identifier },
  });
  revalidateItem(row.item_id);
  return { success: true };
}

/** Re-sync cached status for every Linear issue attached to an item. */
export async function refreshLinearStatus(
  itemId: string,
): Promise<ActionResult> {
  await requirePageAccess(PAGE_KEY);
  if (!z.string().uuid().safeParse(itemId).success) return fail("Invalid id");
  try {
    const links = await adminDb.roadmap_linear_links.findMany({
      where: { item_id: itemId },
      select: { id: true, linear_issue_id: true },
    });
    if (links.length === 0) {
      revalidateItem(itemId);
      return { success: true };
    }
    const map = await getLinearIssues(links.map((l) => l.linear_issue_id));
    await Promise.all(
      links.map((l) => {
        const issue = map.get(l.linear_issue_id);
        if (!issue) return Promise.resolve();
        return adminDb.roadmap_linear_links.update({
          where: { id: l.id },
          data: {
            identifier: issue.identifier,
            title: issue.title,
            url: issue.url,
            state_name: issue.stateName,
            state_type: issue.stateType,
            state_color: issue.stateColor,
            assignee_name: issue.assigneeName,
            synced_at: new Date(),
          },
        });
      }),
    );
    revalidateItem(itemId);
    return { success: true };
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Failed to refresh status");
  }
}

const createIssueSchema = z.object({
  itemId: z.string().uuid(),
  teamId: z.string().min(1, "Pick a team"),
  title: z.string().trim().min(1, "Title is required").max(200),
  description: z.string().trim().max(4000).nullish(),
});

/** Create a brand-new Linear issue and attach it. SUPER-ADMIN (owner) ONLY. */
export async function createLinearIssueAction(
  input: z.infer<typeof createIssueSchema>,
): Promise<ActionResult> {
  const session = await requireOwner();
  const parsed = createIssueSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid input");
  try {
    const issue = await createLinearIssue({
      teamId: parsed.data.teamId,
      title: parsed.data.title,
      description: parsed.data.description ?? undefined,
    });
    await adminDb.roadmap_linear_links.create({
      data: {
        item_id: parsed.data.itemId,
        linear_issue_id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        url: issue.url,
        state_name: issue.stateName,
        state_type: issue.stateType,
        state_color: issue.stateColor,
        assignee_name: issue.assigneeName,
      },
    });
    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "roadmap_linear_created",
      metadata: {
        itemId: parsed.data.itemId,
        identifier: issue.identifier,
        title: issue.title,
      },
    });
    revalidateItem(parsed.data.itemId);
    return { success: true };
  } catch (err) {
    return fail(err instanceof Error ? err.message : "Failed to create issue");
  }
}
