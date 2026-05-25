"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { adminDb } from "@/lib/admin-db";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { requirePageAccess } from "@/lib/dal";
import { ensureEmployeeBoardSchema } from "@/lib/employee-board/ensure-schema";

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

const moveEmployeeSchema = z.object({
  employeeId: z.string().uuid("Invalid employee id"),
  // null = move to the Unassigned pool.
  workspaceId: z.string().uuid("Invalid workspace id").nullable(),
});

const employeeRoleSchema = z.object({
  employeeId: z.string().uuid("Invalid employee id"),
  role: roleSchema,
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

// ── Placements ──────────────────────────────────────────────────────

export async function moveEmployee(
  employeeId: string,
  workspaceId: string | null,
): Promise<{ success: true } | { success: false; error: string }> {
  const session = await requirePageAccess(PAGE_KEY);
  await ensure();
  const parsed = moveEmployeeSchema.safeParse({ employeeId, workspaceId });
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  // The employee must exist in the salary registry — the board is just
  // a view over it. Guard so a bad id can't create an orphan placement
  // (the DB FK would reject it too, but a friendly error is nicer).
  const employee = await adminDb.salary_employees.findUnique({
    where: { id: parsed.data.employeeId },
    select: { id: true },
  });
  if (!employee) return { success: false, error: "Employee not found" };

  // Target workspace must exist when one is given (null = Unassigned).
  if (parsed.data.workspaceId) {
    const workspace = await adminDb.employee_workspaces.findUnique({
      where: { id: parsed.data.workspaceId },
      select: { id: true },
    });
    if (!workspace) return { success: false, error: "Workspace not found" };
  }

  // Append to the end of the target column.
  const last = await adminDb.employee_board_placements.findFirst({
    where: { workspace_id: parsed.data.workspaceId },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  const nextPosition = (last?.position ?? -1) + 1;

  // First move creates the placement (employee_id is unique); later
  // moves update it. Roles are untouched here.
  await adminDb.employee_board_placements.upsert({
    where: { employee_id: parsed.data.employeeId },
    create: {
      employee_id: parsed.data.employeeId,
      workspace_id: parsed.data.workspaceId,
      position: nextPosition,
    },
    update: {
      workspace_id: parsed.data.workspaceId,
      position: nextPosition,
    },
    select: { id: true },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "employee_board_employee_moved",
    metadata: {
      employeeId: parsed.data.employeeId,
      workspaceId: parsed.data.workspaceId,
    },
  });

  revalidatePath(PAGE_KEY);
  return { success: true };
}

export async function addEmployeeRole(
  employeeId: string,
  role: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const session = await requirePageAccess(PAGE_KEY);
  await ensure();
  const parsed = employeeRoleSchema.safeParse({ employeeId, role });
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

  const existing = await adminDb.employee_board_placements.findUnique({
    where: { employee_id: parsed.data.employeeId },
    select: { roles: true },
  });

  // Case-insensitive de-dupe so "Lead" and "lead" don't both stick.
  const current = existing?.roles ?? [];
  if (current.some((r) => r.toLowerCase() === parsed.data.role.toLowerCase())) {
    return { success: false, error: "That role is already added" };
  }
  if (current.length >= 20) {
    return { success: false, error: "Too many roles on this employee" };
  }
  const nextRoles = [...current, parsed.data.role];

  // Adding a role to an employee that's never been placed creates the
  // placement in the Unassigned pool (workspace_id stays null).
  await adminDb.employee_board_placements.upsert({
    where: { employee_id: parsed.data.employeeId },
    create: {
      employee_id: parsed.data.employeeId,
      workspace_id: null,
      roles: nextRoles,
    },
    update: { roles: nextRoles },
    select: { id: true },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "employee_board_role_added",
    metadata: { employeeId: parsed.data.employeeId, role: parsed.data.role },
  });

  revalidatePath(PAGE_KEY);
  return { success: true };
}

export async function removeEmployeeRole(
  employeeId: string,
  role: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const session = await requirePageAccess(PAGE_KEY);
  await ensure();
  const parsed = employeeRoleSchema.safeParse({ employeeId, role });
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }

  const existing = await adminDb.employee_board_placements.findUnique({
    where: { employee_id: parsed.data.employeeId },
    select: { roles: true },
  });
  if (!existing) return { success: false, error: "Employee not placed" };

  const nextRoles = existing.roles.filter(
    (r) => r.toLowerCase() !== parsed.data.role.toLowerCase(),
  );
  if (nextRoles.length === existing.roles.length) {
    return { success: false, error: "Role not found" };
  }

  await adminDb.employee_board_placements.update({
    where: { employee_id: parsed.data.employeeId },
    data: { roles: nextRoles },
    select: { id: true },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "employee_board_role_removed",
    metadata: { employeeId: parsed.data.employeeId, role: parsed.data.role },
  });

  revalidatePath(PAGE_KEY);
  return { success: true };
}
