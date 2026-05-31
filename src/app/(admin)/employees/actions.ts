"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { adminDb } from "@/lib/admin-db";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { requirePageAccess } from "@/lib/dal";
import { ensureEmployeeBoardSchema } from "@/lib/employee-board/ensure-schema";
import {
  deleteDiscordPlacement,
  deleteDiscordServer,
  findDiscordPlacementByEmployeeAndServer,
  findDiscordPlacementById,
  findDiscordServerById,
  getLastDiscordServerPosition,
  getLastPositionInDiscordServer,
  insertDiscordPlacement,
  insertDiscordServer,
  listDiscordPlacementsByIds,
  updateDiscordPlacementRoles,
  updateDiscordPlacementServerAndPosition,
  updateDiscordServerName,
} from "@/lib/employee-board/discord-servers";

const PAGE_KEY = "/employees";

// All write actions self-heal the schema so a missing table doesn't
// surface as a P2021 to the admin. The page does the same.
async function ensure(): Promise<void> {
  await ensureEmployeeBoardSchema().catch(() => {});
}

// ── Schemas ─────────────────────────────────────────────────────────

const workspaceNameSchema = z
  .string()
  .trim()
  .min(1, "Name is required")
  .max(60, "Name must be 60 characters or fewer");

const roleSchema = z
  .string()
  .trim()
  .min(1, "Role is required")
  .max(40, "Role must be 40 characters or fewer");

const createWorkspaceSchema = z.object({ name: workspaceNameSchema });

const renameWorkspaceSchema = z.object({
  id: z.string().uuid("Invalid workspace id"),
  name: workspaceNameSchema,
});

const deleteWorkspaceSchema = z.object({
  id: z.string().uuid("Invalid workspace id"),
});

const placementMoveSchema = z.object({
  placementId: z.string().uuid("Invalid placement id"),
  // null = move to the Unassigned pool (no workspace).
  workspaceId: z.string().uuid("Invalid workspace id").nullable(),
});

const addToWorkspaceSchema = z.object({
  employeeId: z.string().uuid("Invalid employee id"),
  workspaceId: z.string().uuid("Invalid workspace id"),
});

const placementIdSchema = z.object({
  placementId: z.string().uuid("Invalid placement id"),
});

const placementRoleSchema = z.object({
  placementId: z.string().uuid("Invalid placement id"),
  role: roleSchema,
});

const reorderColumnSchema = z.object({
  // null = Unassigned pool. Postgres' unique index treats NULL rows as
  // distinct, so the legacy roles-only Unassigned rows still order
  // alongside any new ones via this same action.
  workspaceId: z.string().uuid("Invalid workspace id").nullable(),
  placementIds: z
    .array(z.string().uuid("Invalid placement id"))
    .min(1, "Empty order list")
    .max(500, "Too many placements"),
});

const managerEmployeeSchema = z.object({
  employeeId: z.string().uuid("Invalid employee id"),
});

const managerIdSchema = z.object({
  managerId: z.string().uuid("Invalid manager id"),
});

const managerWorkspaceSchema = z.object({
  managerId: z.string().uuid("Invalid manager id"),
  workspaceId: z.string().uuid("Invalid workspace id"),
});

// ── Discord-server schemas ──────────────────────────────────────────

const discordServerNameSchema = z
  .string()
  .trim()
  .min(1, "Name is required")
  .max(60, "Name must be 60 characters or fewer");

const createDiscordServerSchema = z.object({ name: discordServerNameSchema });

const renameDiscordServerSchema = z.object({
  id: z.string().uuid("Invalid discord server id"),
  name: discordServerNameSchema,
});

const deleteDiscordServerSchema = z.object({
  id: z.string().uuid("Invalid discord server id"),
});

const addToDiscordServerSchema = z.object({
  employeeId: z.string().uuid("Invalid employee id"),
  discordServerId: z.string().uuid("Invalid discord server id"),
});

const discordPlacementIdSchema = z.object({
  placementId: z.string().uuid("Invalid placement id"),
});

const discordPlacementRoleSchema = z.object({
  placementId: z.string().uuid("Invalid placement id"),
  role: roleSchema,
});

const moveDiscordPlacementSchema = z.object({
  placementId: z.string().uuid("Invalid placement id"),
  discordServerId: z.string().uuid("Invalid discord server id"),
});

const reorderDiscordColumnSchema = z.object({
  discordServerId: z.string().uuid("Invalid discord server id"),
  placementIds: z
    .array(z.string().uuid("Invalid placement id"))
    .min(1, "Empty order list")
    .max(500, "Too many placements"),
});

// ── Workspaces ──────────────────────────────────────────────────────

export async function createWorkspace(
  name: string,
): Promise<{ success: true; id: string } | { success: false; error: string }> {
  const session = await requirePageAccess(PAGE_KEY);
  await ensure();
  const parsed = createWorkspaceSchema.safeParse({ name });
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  // Append new columns to the end of the current ordering.
  const last = await adminDb.employee_workspaces.findFirst({
    orderBy: { position: "desc" },
    select: { position: true },
  });
  const nextPosition = (last?.position ?? -1) + 1;

  const created = await adminDb.employee_workspaces.create({
    data: { name: parsed.data.name, position: nextPosition },
    select: { id: true },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "employee_board_workspace_created",
    metadata: { workspaceId: created.id, name: parsed.data.name },
  });

  revalidatePath(PAGE_KEY);
  return { success: true, id: created.id };
}

export async function renameWorkspace(
  id: string,
  name: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const session = await requirePageAccess(PAGE_KEY);
  await ensure();
  const parsed = renameWorkspaceSchema.safeParse({ id, name });
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  try {
    await adminDb.employee_workspaces.update({
      where: { id: parsed.data.id },
      data: { name: parsed.data.name },
      select: { id: true },
    });
  } catch {
    return { success: false, error: "Workspace not found" };
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "employee_board_workspace_renamed",
    metadata: { workspaceId: parsed.data.id, name: parsed.data.name },
  });

  revalidatePath(PAGE_KEY);
  return { success: true };
}

export async function deleteWorkspace(
  id: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const session = await requirePageAccess(PAGE_KEY);
  await ensure();
  const parsed = deleteWorkspaceSchema.safeParse({ id });
  if (!parsed.success) {
    return { success: false, error: "Invalid workspace id" };
  }

  // Placements survive the delete — the DB FK is ON DELETE SET NULL, so
  // any cards in this column fall back to the Unassigned pool rather
  // than being destroyed.
  try {
    await adminDb.employee_workspaces.delete({
      where: { id: parsed.data.id },
      select: { id: true },
    });
  } catch {
    return { success: false, error: "Workspace not found" };
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "employee_board_workspace_deleted",
    metadata: { workspaceId: parsed.data.id },
  });

  revalidatePath(PAGE_KEY);
  return { success: true };
}

// ── Placements (multi-section) ──────────────────────────────────────
// In v2 an employee can have multiple placements (one per section). All
// placement operations are keyed on `placement_id` so dragging the
// "Marketing" card for Alice doesn't disturb her "Sales" card.

/**
 * Add an employee to a workspace. Creates a NEW placement row — does
 * NOT touch the employee's other placements. Idempotent: trying to add
 * an employee to a section they're already in returns a friendly error
 * instead of throwing on the (employee_id, workspace_id) unique
 * constraint.
 */
export async function addEmployeeToWorkspace(
  employeeId: string,
  workspaceId: string,
): Promise<{ success: true; placementId: string } | { success: false; error: string }> {
  const session = await requirePageAccess(PAGE_KEY);
  await ensure();
  const parsed = addToWorkspaceSchema.safeParse({ employeeId, workspaceId });
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  // The employee must exist in the salary registry.
  const employee = await adminDb.salary_employees.findUnique({
    where: { id: parsed.data.employeeId },
    select: { id: true },
  });
  if (!employee) return { success: false, error: "Employee not found" };

  const workspace = await adminDb.employee_workspaces.findUnique({
    where: { id: parsed.data.workspaceId },
    select: { id: true },
  });
  if (!workspace) return { success: false, error: "Workspace not found" };

  // Idempotency guard — the unique index would error otherwise.
  const existing = await adminDb.employee_board_placements.findUnique({
    where: {
      employee_id_workspace_id: {
        employee_id: parsed.data.employeeId,
        workspace_id: parsed.data.workspaceId,
      },
    },
    select: { id: true },
  });
  if (existing) {
    return { success: false, error: "Already in this section" };
  }

  // Append to the end of the target column.
  const last = await adminDb.employee_board_placements.findFirst({
    where: { workspace_id: parsed.data.workspaceId },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  const nextPosition = (last?.position ?? -1) + 1;

  const created = await adminDb.employee_board_placements.create({
    data: {
      employee_id: parsed.data.employeeId,
      workspace_id: parsed.data.workspaceId,
      position: nextPosition,
    },
    select: { id: true },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "employee_board_placement_added",
    metadata: {
      placementId: created.id,
      employeeId: parsed.data.employeeId,
      workspaceId: parsed.data.workspaceId,
    },
  });

  revalidatePath(PAGE_KEY);
  return { success: true, placementId: created.id };
}

/**
 * Move ONE specific placement to a different workspace (or to
 * Unassigned via workspaceId = null). The employee's OTHER placements
 * in other sections are untouched. Drops the placement when the move
 * would land it on top of a placement that already exists for the same
 * employee in the target workspace (i.e. you dragged the "Marketing"
 * card on top of where a "Sales" card already lives for the same
 * person) — merging is friendlier than throwing on the unique index.
 */
export async function movePlacement(
  placementId: string,
  workspaceId: string | null,
): Promise<{ success: true } | { success: false; error: string }> {
  const session = await requirePageAccess(PAGE_KEY);
  await ensure();
  const parsed = placementMoveSchema.safeParse({ placementId, workspaceId });
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  const placement = await adminDb.employee_board_placements.findUnique({
    where: { id: parsed.data.placementId },
    select: { id: true, employee_id: true, workspace_id: true },
  });
  if (!placement) return { success: false, error: "Placement not found" };

  // Target workspace must exist when one is given (null = Unassigned).
  if (parsed.data.workspaceId) {
    const workspace = await adminDb.employee_workspaces.findUnique({
      where: { id: parsed.data.workspaceId },
      select: { id: true },
    });
    if (!workspace) return { success: false, error: "Workspace not found" };
  }

  // No-op if it's already in the target column.
  if (placement.workspace_id === parsed.data.workspaceId) {
    return { success: true };
  }

  // If the employee already has a placement in the target workspace,
  // drop THIS placement instead of creating a duplicate (the unique
  // (employee_id, workspace_id) index would reject the move otherwise).
  if (parsed.data.workspaceId) {
    const conflict = await adminDb.employee_board_placements.findUnique({
      where: {
        employee_id_workspace_id: {
          employee_id: placement.employee_id,
          workspace_id: parsed.data.workspaceId,
        },
      },
      select: { id: true },
    });
    if (conflict) {
      await adminDb.employee_board_placements.delete({
        where: { id: placement.id },
        select: { id: true },
      });
      await createAdminAuditEvent({
        adminUserId: session.userId,
        eventType: "employee_board_placement_merged",
        metadata: {
          droppedPlacementId: placement.id,
          keptPlacementId: conflict.id,
          employeeId: placement.employee_id,
          workspaceId: parsed.data.workspaceId,
        },
      });
      revalidatePath(PAGE_KEY);
      return { success: true };
    }
  }

  // Append to the end of the target column.
  const last = await adminDb.employee_board_placements.findFirst({
    where: { workspace_id: parsed.data.workspaceId },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  const nextPosition = (last?.position ?? -1) + 1;

  await adminDb.employee_board_placements.update({
    where: { id: parsed.data.placementId },
    data: {
      workspace_id: parsed.data.workspaceId,
      position: nextPosition,
    },
    select: { id: true },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "employee_board_placement_moved",
    metadata: {
      placementId: parsed.data.placementId,
      fromWorkspaceId: placement.workspace_id,
      toWorkspaceId: parsed.data.workspaceId,
    },
  });

  revalidatePath(PAGE_KEY);
  return { success: true };
}

/**
 * Remove ONE placement row. The employee disappears from that section
 * but stays in any other sections they were placed in. If this is
 * their last placement they return to Unassigned (implicit).
 */
export async function removePlacement(
  placementId: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const session = await requirePageAccess(PAGE_KEY);
  await ensure();
  const parsed = placementIdSchema.safeParse({ placementId });
  if (!parsed.success) {
    return { success: false, error: "Invalid placement id" };
  }

  const placement = await adminDb.employee_board_placements.findUnique({
    where: { id: parsed.data.placementId },
    select: { id: true, employee_id: true, workspace_id: true },
  });
  if (!placement) return { success: false, error: "Placement not found" };

  await adminDb.employee_board_placements.delete({
    where: { id: parsed.data.placementId },
    select: { id: true },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "employee_board_placement_removed",
    metadata: {
      placementId: parsed.data.placementId,
      employeeId: placement.employee_id,
      workspaceId: placement.workspace_id,
    },
  });

  revalidatePath(PAGE_KEY);
  return { success: true };
}

/**
 * Bulk-update the `position` of every placement inside a single column
 * (workspace or Unassigned). The caller passes the desired order as an
 * array of placement ids; we update each row's position to its index in
 * that array. Single transaction so the column never appears half-
 * shuffled on a refresh.
 */
export async function reorderColumn(
  workspaceId: string | null,
  placementIds: string[],
): Promise<{ success: true } | { success: false; error: string }> {
  const session = await requirePageAccess(PAGE_KEY);
  await ensure();
  const parsed = reorderColumnSchema.safeParse({ workspaceId, placementIds });
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  // Guard: every id must currently live in this column. Prevents a
  // stale client from reordering a placement that has already moved.
  const rows = await adminDb.employee_board_placements.findMany({
    where: { id: { in: parsed.data.placementIds } },
    select: { id: true, workspace_id: true },
  });
  if (rows.length !== parsed.data.placementIds.length) {
    return { success: false, error: "Some placements no longer exist" };
  }
  for (const r of rows) {
    if (r.workspace_id !== parsed.data.workspaceId) {
      return {
        success: false,
        error: "Some placements are no longer in this column",
      };
    }
  }

  // One transaction so a partial failure can't leave the column with
  // duplicate or missing positions.
  await adminDb.$transaction(
    parsed.data.placementIds.map((id, idx) =>
      adminDb.employee_board_placements.update({
        where: { id },
        data: { position: idx },
        select: { id: true },
      }),
    ),
  );

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "employee_board_column_reordered",
    metadata: {
      workspaceId: parsed.data.workspaceId,
      placementIds: parsed.data.placementIds,
    },
  });

  revalidatePath(PAGE_KEY);
  return { success: true };
}

// ── Roles (per-placement) ───────────────────────────────────────────
// Roles live on the placement row so the same employee can carry
// different roles in different sections (e.g. "Lead" in Marketing,
// "Backup" in Support).

export async function addPlacementRole(
  placementId: string,
  role: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const session = await requirePageAccess(PAGE_KEY);
  await ensure();
  const parsed = placementRoleSchema.safeParse({ placementId, role });
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  const existing = await adminDb.employee_board_placements.findUnique({
    where: { id: parsed.data.placementId },
    select: { id: true, employee_id: true, workspace_id: true, roles: true },
  });
  if (!existing) return { success: false, error: "Placement not found" };

  // Case-insensitive de-dupe so "Lead" and "lead" don't both stick.
  if (
    existing.roles.some((r) => r.toLowerCase() === parsed.data.role.toLowerCase())
  ) {
    return { success: false, error: "That role is already added" };
  }
  if (existing.roles.length >= 20) {
    return { success: false, error: "Too many roles on this placement" };
  }

  await adminDb.employee_board_placements.update({
    where: { id: parsed.data.placementId },
    data: { roles: [...existing.roles, parsed.data.role] },
    select: { id: true },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "employee_board_role_added",
    metadata: {
      placementId: parsed.data.placementId,
      employeeId: existing.employee_id,
      workspaceId: existing.workspace_id,
      role: parsed.data.role,
    },
  });

  revalidatePath(PAGE_KEY);
  return { success: true };
}

export async function removePlacementRole(
  placementId: string,
  role: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const session = await requirePageAccess(PAGE_KEY);
  await ensure();
  const parsed = placementRoleSchema.safeParse({ placementId, role });
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  const existing = await adminDb.employee_board_placements.findUnique({
    where: { id: parsed.data.placementId },
    select: { id: true, employee_id: true, workspace_id: true, roles: true },
  });
  if (!existing) return { success: false, error: "Placement not found" };

  const nextRoles = existing.roles.filter(
    (r) => r.toLowerCase() !== parsed.data.role.toLowerCase(),
  );
  if (nextRoles.length === existing.roles.length) {
    return { success: false, error: "Role not found" };
  }

  await adminDb.employee_board_placements.update({
    where: { id: parsed.data.placementId },
    data: { roles: nextRoles },
    select: { id: true },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "employee_board_role_removed",
    metadata: {
      placementId: parsed.data.placementId,
      employeeId: existing.employee_id,
      workspaceId: existing.workspace_id,
      role: parsed.data.role,
    },
  });

  revalidatePath(PAGE_KEY);
  return { success: true };
}

// ── Managers ────────────────────────────────────────────────────────
// A manager is an employee promoted into the row above the columns. It
// is a separate concept from a placement: the employee keeps any column
// placement/roles (so demoting returns them to where they were), but the
// page hides managers from the columns and renders them as manager
// blocks instead.

export async function addManager(
  employeeId: string,
): Promise<{ success: true; id: string } | { success: false; error: string }> {
  const session = await requirePageAccess(PAGE_KEY);
  await ensure();
  const parsed = managerEmployeeSchema.safeParse({ employeeId });
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  // Must be a real salary employee (DB FK enforces this too).
  const employee = await adminDb.salary_employees.findUnique({
    where: { id: parsed.data.employeeId },
    select: { id: true },
  });
  if (!employee) return { success: false, error: "Employee not found" };

  // employee_id is UNIQUE — can't promote the same person twice.
  const existing = await adminDb.employee_managers.findUnique({
    where: { employee_id: parsed.data.employeeId },
    select: { id: true },
  });
  if (existing) return { success: false, error: "Already a manager" };

  // Append to the end of the manager row.
  const last = await adminDb.employee_managers.findFirst({
    orderBy: { position: "desc" },
    select: { position: true },
  });
  const nextPosition = (last?.position ?? -1) + 1;

  const created = await adminDb.employee_managers.create({
    data: { employee_id: parsed.data.employeeId, position: nextPosition },
    select: { id: true },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "employee_board_manager_added",
    metadata: { managerId: created.id, employeeId: parsed.data.employeeId },
  });

  revalidatePath(PAGE_KEY);
  return { success: true, id: created.id };
}

export async function removeManager(
  managerId: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const session = await requirePageAccess(PAGE_KEY);
  await ensure();
  const parsed = managerIdSchema.safeParse({ managerId });
  if (!parsed.success) {
    return { success: false, error: "Invalid manager id" };
  }

  // Deleting the manager cascades to its workspace links (the lines).
  // The employee + their column placement/roles are untouched.
  try {
    await adminDb.employee_managers.delete({
      where: { id: parsed.data.managerId },
      select: { id: true },
    });
  } catch {
    return { success: false, error: "Manager not found" };
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "employee_board_manager_removed",
    metadata: { managerId: parsed.data.managerId },
  });

  revalidatePath(PAGE_KEY);
  return { success: true };
}

export async function linkManagerWorkspace(
  managerId: string,
  workspaceId: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const session = await requirePageAccess(PAGE_KEY);
  await ensure();
  const parsed = managerWorkspaceSchema.safeParse({ managerId, workspaceId });
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  const [manager, workspace] = await Promise.all([
    adminDb.employee_managers.findUnique({
      where: { id: parsed.data.managerId },
      select: { id: true },
    }),
    adminDb.employee_workspaces.findUnique({
      where: { id: parsed.data.workspaceId },
      select: { id: true },
    }),
  ]);
  if (!manager) return { success: false, error: "Manager not found" };
  if (!workspace) return { success: false, error: "Workspace not found" };

  // Idempotent: a duplicate link is a no-op (the UI only offers unlinked
  // workspaces, but guard against double-submits / races).
  const existing = await adminDb.employee_manager_workspaces.findFirst({
    where: {
      manager_id: parsed.data.managerId,
      workspace_id: parsed.data.workspaceId,
    },
    select: { id: true },
  });
  if (existing) return { success: true };

  await adminDb.employee_manager_workspaces.create({
    data: {
      manager_id: parsed.data.managerId,
      workspace_id: parsed.data.workspaceId,
    },
    select: { id: true },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "employee_board_manager_linked",
    metadata: {
      managerId: parsed.data.managerId,
      workspaceId: parsed.data.workspaceId,
    },
  });

  revalidatePath(PAGE_KEY);
  return { success: true };
}

export async function unlinkManagerWorkspace(
  managerId: string,
  workspaceId: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const session = await requirePageAccess(PAGE_KEY);
  await ensure();
  const parsed = managerWorkspaceSchema.safeParse({ managerId, workspaceId });
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  const deleted = await adminDb.employee_manager_workspaces.deleteMany({
    where: {
      manager_id: parsed.data.managerId,
      workspace_id: parsed.data.workspaceId,
    },
  });
  if (deleted.count === 0) {
    return { success: false, error: "Link not found" };
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "employee_board_manager_unlinked",
    metadata: {
      managerId: parsed.data.managerId,
      workspaceId: parsed.data.workspaceId,
    },
  });

  revalidatePath(PAGE_KEY);
  return { success: true };
}

// ── Discord servers ─────────────────────────────────────────────────
// A discord server is a third "kind" of board column, rendered in its
// own section below the regular workspace row. Backed by separate
// tables (employee_discord_servers + employee_discord_server_placements)
// so the existing workspace flow doesn't change. All access goes
// through the typed raw-SQL wrappers in
// @/lib/employee-board/discord-servers (the new tables are NOT in the
// Prisma admin schema — same admin-DB "no migration file" reason as
// the workspace tables, but kept out of the Prisma model file too).
//
// Cross-type drag-and-drop (workspace card → discord column, and the
// reverse) is implemented as a MOVE: the source row is deleted and a
// new row is created in the target type's placement table, preserving
// the per-placement `roles[]`. Multi-placement (the same employee in
// multiple discord servers AND multiple workspaces) is achieved via
// each column's "+ Add member" button, identical to the workspace
// model.

export async function createDiscordServer(
  name: string,
): Promise<{ success: true; id: string } | { success: false; error: string }> {
  const session = await requirePageAccess(PAGE_KEY);
  await ensure();
  const parsed = createDiscordServerSchema.safeParse({ name });
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  const nextPosition = (await getLastDiscordServerPosition()) + 1;
  const created = await insertDiscordServer(parsed.data.name, nextPosition);

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "employee_board_discord_server_created",
    metadata: { discordServerId: created.id, name: parsed.data.name },
  });

  revalidatePath(PAGE_KEY);
  return { success: true, id: created.id };
}

export async function renameDiscordServer(
  id: string,
  name: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const session = await requirePageAccess(PAGE_KEY);
  await ensure();
  const parsed = renameDiscordServerSchema.safeParse({ id, name });
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  const updated = await updateDiscordServerName(parsed.data.id, parsed.data.name);
  if (!updated) return { success: false, error: "Discord server not found" };

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "employee_board_discord_server_renamed",
    metadata: { discordServerId: parsed.data.id, name: parsed.data.name },
  });

  revalidatePath(PAGE_KEY);
  return { success: true };
}

export async function deleteDiscordServerAction(
  id: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const session = await requirePageAccess(PAGE_KEY);
  await ensure();
  const parsed = deleteDiscordServerSchema.safeParse({ id });
  if (!parsed.success) {
    return { success: false, error: "Invalid discord server id" };
  }

  // Placements CASCADE on delete (see ensure-schema.ts) — cards on
  // this server disappear; the employees fall back to Unassigned if
  // they had no other placements (workspace or discord).
  const deleted = await deleteDiscordServer(parsed.data.id);
  if (!deleted) return { success: false, error: "Discord server not found" };

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "employee_board_discord_server_deleted",
    metadata: { discordServerId: parsed.data.id },
  });

  revalidatePath(PAGE_KEY);
  return { success: true };
}

/**
 * Add an employee to a discord server. Creates a NEW placement row —
 * does NOT touch the employee's workspace placements or other discord
 * placements. Idempotent: trying to add the same employee twice
 * returns a friendly error instead of erroring on the unique index.
 */
export async function addEmployeeToDiscordServer(
  employeeId: string,
  discordServerId: string,
): Promise<{ success: true; placementId: string } | { success: false; error: string }> {
  const session = await requirePageAccess(PAGE_KEY);
  await ensure();
  const parsed = addToDiscordServerSchema.safeParse({
    employeeId,
    discordServerId,
  });
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  const employee = await adminDb.salary_employees.findUnique({
    where: { id: parsed.data.employeeId },
    select: { id: true },
  });
  if (!employee) return { success: false, error: "Employee not found" };

  const server = await findDiscordServerById(parsed.data.discordServerId);
  if (!server) return { success: false, error: "Discord server not found" };

  const existing = await findDiscordPlacementByEmployeeAndServer(
    parsed.data.employeeId,
    parsed.data.discordServerId,
  );
  if (existing) {
    return { success: false, error: "Already in this server" };
  }

  const nextPosition =
    (await getLastPositionInDiscordServer(parsed.data.discordServerId)) + 1;
  const created = await insertDiscordPlacement({
    employeeId: parsed.data.employeeId,
    discordServerId: parsed.data.discordServerId,
    position: nextPosition,
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "employee_board_discord_placement_added",
    metadata: {
      placementId: created.id,
      employeeId: parsed.data.employeeId,
      discordServerId: parsed.data.discordServerId,
    },
  });

  revalidatePath(PAGE_KEY);
  return { success: true, placementId: created.id };
}

/**
 * Move ONE discord placement to a different discord server. Mirrors
 * movePlacement for workspaces but stays within the discord-server
 * "side track" — cross-type moves (discord ↔ workspace) and removal
 * (drop on Unassigned) are separate actions.
 */
export async function moveDiscordPlacement(
  placementId: string,
  discordServerId: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const session = await requirePageAccess(PAGE_KEY);
  await ensure();
  const parsed = moveDiscordPlacementSchema.safeParse({
    placementId,
    discordServerId,
  });
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  const placement = await findDiscordPlacementById(parsed.data.placementId);
  if (!placement) return { success: false, error: "Placement not found" };

  const server = await findDiscordServerById(parsed.data.discordServerId);
  if (!server) return { success: false, error: "Discord server not found" };

  if (placement.discord_server_id === parsed.data.discordServerId) {
    return { success: true };
  }

  // Merge-on-conflict — same friendly behaviour as movePlacement.
  const conflict = await findDiscordPlacementByEmployeeAndServer(
    placement.employee_id,
    parsed.data.discordServerId,
  );
  if (conflict) {
    await deleteDiscordPlacement(placement.id);
    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "employee_board_discord_placement_merged",
      metadata: {
        droppedPlacementId: placement.id,
        keptPlacementId: conflict.id,
        employeeId: placement.employee_id,
        discordServerId: parsed.data.discordServerId,
      },
    });
    revalidatePath(PAGE_KEY);
    return { success: true };
  }

  const nextPosition =
    (await getLastPositionInDiscordServer(parsed.data.discordServerId)) + 1;
  await updateDiscordPlacementServerAndPosition(
    parsed.data.placementId,
    parsed.data.discordServerId,
    nextPosition,
  );

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "employee_board_discord_placement_moved",
    metadata: {
      placementId: parsed.data.placementId,
      fromDiscordServerId: placement.discord_server_id,
      toDiscordServerId: parsed.data.discordServerId,
    },
  });

  revalidatePath(PAGE_KEY);
  return { success: true };
}

/**
 * Remove a discord placement. The employee disappears from that
 * server but keeps every other placement (workspace and discord). If
 * this was their last placement they return to Unassigned (the page
 * computes the synthetic unplaced cards from `employees − placed`).
 */
export async function removeDiscordPlacement(
  placementId: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const session = await requirePageAccess(PAGE_KEY);
  await ensure();
  const parsed = discordPlacementIdSchema.safeParse({ placementId });
  if (!parsed.success) {
    return { success: false, error: "Invalid placement id" };
  }

  const placement = await findDiscordPlacementById(parsed.data.placementId);
  if (!placement) return { success: false, error: "Placement not found" };

  await deleteDiscordPlacement(parsed.data.placementId);

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "employee_board_discord_placement_removed",
    metadata: {
      placementId: parsed.data.placementId,
      employeeId: placement.employee_id,
      discordServerId: placement.discord_server_id,
    },
  });

  revalidatePath(PAGE_KEY);
  return { success: true };
}

/**
 * Bulk-update positions inside one discord-server column. Same shape
 * as reorderColumn for workspaces but constrained to a single discord
 * server (no "Unassigned for discord" — synthetic cards live in the
 * workspace-level Unassigned only).
 */
export async function reorderDiscordColumn(
  discordServerId: string,
  placementIds: string[],
): Promise<{ success: true } | { success: false; error: string }> {
  const session = await requirePageAccess(PAGE_KEY);
  await ensure();
  const parsed = reorderDiscordColumnSchema.safeParse({
    discordServerId,
    placementIds,
  });
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  const rows = await listDiscordPlacementsByIds(parsed.data.placementIds);
  if (rows.length !== parsed.data.placementIds.length) {
    return { success: false, error: "Some placements no longer exist" };
  }
  for (const r of rows) {
    if (r.discord_server_id !== parsed.data.discordServerId) {
      return {
        success: false,
        error: "Some placements are no longer in this column",
      };
    }
  }

  await adminDb.$transaction(
    parsed.data.placementIds.map((id, idx) =>
      adminDb.$executeRaw`
        UPDATE "employee_discord_server_placements"
           SET position = ${idx},
               updated_at = now()
         WHERE id = ${id}::uuid
      `,
    ),
  );

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "employee_board_discord_column_reordered",
    metadata: {
      discordServerId: parsed.data.discordServerId,
      placementIds: parsed.data.placementIds,
    },
  });

  revalidatePath(PAGE_KEY);
  return { success: true };
}

export async function addDiscordPlacementRole(
  placementId: string,
  role: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const session = await requirePageAccess(PAGE_KEY);
  await ensure();
  const parsed = discordPlacementRoleSchema.safeParse({ placementId, role });
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  const existing = await findDiscordPlacementById(parsed.data.placementId);
  if (!existing) return { success: false, error: "Placement not found" };

  if (
    existing.roles.some(
      (r) => r.toLowerCase() === parsed.data.role.toLowerCase(),
    )
  ) {
    return { success: false, error: "That role is already added" };
  }
  if (existing.roles.length >= 20) {
    return { success: false, error: "Too many roles on this placement" };
  }

  await updateDiscordPlacementRoles(parsed.data.placementId, [
    ...existing.roles,
    parsed.data.role,
  ]);

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "employee_board_discord_role_added",
    metadata: {
      placementId: parsed.data.placementId,
      employeeId: existing.employee_id,
      discordServerId: existing.discord_server_id,
      role: parsed.data.role,
    },
  });

  revalidatePath(PAGE_KEY);
  return { success: true };
}

export async function removeDiscordPlacementRole(
  placementId: string,
  role: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const session = await requirePageAccess(PAGE_KEY);
  await ensure();
  const parsed = discordPlacementRoleSchema.safeParse({ placementId, role });
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  const existing = await findDiscordPlacementById(parsed.data.placementId);
  if (!existing) return { success: false, error: "Placement not found" };

  const nextRoles = existing.roles.filter(
    (r) => r.toLowerCase() !== parsed.data.role.toLowerCase(),
  );
  if (nextRoles.length === existing.roles.length) {
    return { success: false, error: "Role not found" };
  }

  await updateDiscordPlacementRoles(parsed.data.placementId, nextRoles);

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "employee_board_discord_role_removed",
    metadata: {
      placementId: parsed.data.placementId,
      employeeId: existing.employee_id,
      discordServerId: existing.discord_server_id,
      role: parsed.data.role,
    },
  });

  revalidatePath(PAGE_KEY);
  return { success: true };
}

// ── Cross-type moves (workspace ↔ discord) ─────────────────────────
// The board allows dragging a card between the workspace row and the
// discord-server row. Because placements live in two separate tables,
// the move is implemented as DELETE-from-source + INSERT-into-target,
// carrying the `roles[]` across so the user doesn't lose their tagging.

/**
 * Move a WORKSPACE placement into a discord server. Deletes the
 * workspace placement and creates a new discord placement for the
 * same employee, preserving the role list. If the employee already
 * has a placement on that discord server we merge (just drop the
 * workspace placement) the same way movePlacement does.
 */
export async function moveWorkspacePlacementToDiscord(
  placementId: string,
  discordServerId: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const session = await requirePageAccess(PAGE_KEY);
  await ensure();
  const parsed = z
    .object({
      placementId: z.string().uuid("Invalid placement id"),
      discordServerId: z.string().uuid("Invalid discord server id"),
    })
    .safeParse({ placementId, discordServerId });
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  const placement = await adminDb.employee_board_placements.findUnique({
    where: { id: parsed.data.placementId },
    select: {
      id: true,
      employee_id: true,
      workspace_id: true,
      roles: true,
    },
  });
  if (!placement) return { success: false, error: "Placement not found" };

  const server = await findDiscordServerById(parsed.data.discordServerId);
  if (!server) return { success: false, error: "Discord server not found" };

  const conflict = await findDiscordPlacementByEmployeeAndServer(
    placement.employee_id,
    parsed.data.discordServerId,
  );

  // Single transaction so the source row never sticks around if the
  // insert fails (and vice versa). The discord-side tables aren't
  // Prisma models, so we mix typed Prisma + $executeRaw inside the
  // same interactive transaction.
  await adminDb.$transaction(async (tx) => {
    await tx.employee_board_placements.delete({
      where: { id: parsed.data.placementId },
      select: { id: true },
    });
    if (conflict) return; // merge — discord placement already exists.
    // Look up the next position inside the transaction so two
    // concurrent moves can't pick the same trailing index.
    const posRows = await tx.$queryRaw<{ max: number | null }[]>`
      SELECT MAX(position)::int AS max
        FROM "employee_discord_server_placements"
       WHERE discord_server_id = ${parsed.data.discordServerId}::uuid
    `;
    const max = posRows[0]?.max;
    const nextPosition =
      max === null || max === undefined ? 0 : Number(max) + 1;
    await tx.$executeRaw`
      INSERT INTO "employee_discord_server_placements"
          ("employee_id", "discord_server_id", "position", "roles")
      VALUES (${placement.employee_id}::uuid,
              ${parsed.data.discordServerId}::uuid,
              ${nextPosition},
              ${placement.roles}::text[])
    `;
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "employee_board_placement_cross_moved",
    metadata: {
      fromKind: "workspace",
      toKind: "discord_server",
      sourcePlacementId: parsed.data.placementId,
      fromWorkspaceId: placement.workspace_id,
      toDiscordServerId: parsed.data.discordServerId,
      employeeId: placement.employee_id,
      mergedInto: conflict?.id ?? null,
    },
  });

  revalidatePath(PAGE_KEY);
  return { success: true };
}

/**
 * Move a DISCORD placement into a workspace. Mirror of
 * moveWorkspacePlacementToDiscord. Roles are carried over; if the
 * employee already has a placement in the target workspace we merge.
 */
export async function moveDiscordPlacementToWorkspace(
  placementId: string,
  workspaceId: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const session = await requirePageAccess(PAGE_KEY);
  await ensure();
  const parsed = z
    .object({
      placementId: z.string().uuid("Invalid placement id"),
      workspaceId: z.string().uuid("Invalid workspace id"),
    })
    .safeParse({ placementId, workspaceId });
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  const placement = await findDiscordPlacementById(parsed.data.placementId);
  if (!placement) return { success: false, error: "Placement not found" };

  const workspace = await adminDb.employee_workspaces.findUnique({
    where: { id: parsed.data.workspaceId },
    select: { id: true },
  });
  if (!workspace) return { success: false, error: "Workspace not found" };

  const conflict = await adminDb.employee_board_placements.findUnique({
    where: {
      employee_id_workspace_id: {
        employee_id: placement.employee_id,
        workspace_id: parsed.data.workspaceId,
      },
    },
    select: { id: true },
  });

  await adminDb.$transaction(async (tx) => {
    await tx.$executeRaw`
      DELETE FROM "employee_discord_server_placements"
       WHERE id = ${parsed.data.placementId}::uuid
    `;
    if (conflict) return; // merge — workspace placement already exists.
    const last = await tx.employee_board_placements.findFirst({
      where: { workspace_id: parsed.data.workspaceId },
      orderBy: { position: "desc" },
      select: { position: true },
    });
    const nextPosition = (last?.position ?? -1) + 1;
    await tx.employee_board_placements.create({
      data: {
        employee_id: placement.employee_id,
        workspace_id: parsed.data.workspaceId,
        position: nextPosition,
        roles: placement.roles,
      },
      select: { id: true },
    });
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "employee_board_placement_cross_moved",
    metadata: {
      fromKind: "discord_server",
      toKind: "workspace",
      sourcePlacementId: parsed.data.placementId,
      fromDiscordServerId: placement.discord_server_id,
      toWorkspaceId: parsed.data.workspaceId,
      employeeId: placement.employee_id,
      mergedInto: conflict?.id ?? null,
    },
  });

  revalidatePath(PAGE_KEY);
  return { success: true };
}
