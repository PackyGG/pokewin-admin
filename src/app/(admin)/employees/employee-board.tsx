"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  Plus,
  Trash2,
  GripVertical,
  X,
  Inbox,
  Users,
  Check,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  createWorkspace,
  renameWorkspace,
  deleteWorkspace,
  moveEmployee,
  addEmployeeRole,
  removeEmployeeRole,
} from "./actions";

// ─── Types ───────────────────────────────────────────────────────────
// Serializable props only — no functions cross the RSC boundary.

type EmployeeCard = {
  id: string;
  discordName: string;
  active: boolean;
  workspaceId: string | null;
  roles: string[];
  position: number;
};

type Workspace = {
  id: string;
  name: string;
};

// Sentinel column id for the Unassigned pool (workspaceId === null).
const UNASSIGNED = "__unassigned__";

// ─── Board ───────────────────────────────────────────────────────────

export function EmployeeBoard({
  employees,
  workspaces,
}: {
  employees: EmployeeCard[];
  workspaces: Workspace[];
}) {
  const router = useRouter();
  const sensors = useSensors(
    useSensor(PointerSensor, {
      // Small activation distance so a click (to add a role) isn't
      // swallowed as the start of a drag.
      activationConstraint: { distance: 6 },
    }),
  );

  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [newWorkspace, setNewWorkspace] = React.useState("");
  const [creating, setCreating] = React.useState(false);

  // Group employees by column. Recomputed whenever the server data
  // changes after a router.refresh().
  const byColumn = React.useMemo(() => {
    const map = new Map<string, EmployeeCard[]>();
    map.set(UNASSIGNED, []);
    for (const w of workspaces) map.set(w.id, []);
    for (const e of employees) {
      const key =
        e.workspaceId && map.has(e.workspaceId) ? e.workspaceId : UNASSIGNED;
      map.get(key)!.push(e);
    }
    // Stable order: by saved position, then discord name.
    for (const list of map.values()) {
      list.sort(
        (a, b) =>
          a.position - b.position ||
          a.discordName.localeCompare(b.discordName),
      );
    }
    return map;
  }, [employees, workspaces]);

  const activeEmployee = React.useMemo(
    () => employees.find((e) => e.id === activeId) ?? null,
    [employees, activeId],
  );

  function handleDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id));
  }

  async function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const { active, over } = event;
    if (!over) return;

    const employeeId = String(active.id);
    const employee = employees.find((e) => e.id === employeeId);
    if (!employee) return;

    // Droppable id is the column id (UNASSIGNED sentinel or a real
    // workspace uuid). Translate the sentinel back to null for the
    // server action.
    const overColumn = String(over.id);
    const targetWorkspaceId = overColumn === UNASSIGNED ? null : overColumn;
    const currentWorkspaceId = employee.workspaceId ?? null;
    if (targetWorkspaceId === currentWorkspaceId) return;

    try {
      const result = await moveEmployee(employeeId, targetWorkspaceId);
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      const label =
        targetWorkspaceId === null
          ? "Unassigned"
          : (workspaces.find((w) => w.id === targetWorkspaceId)?.name ??
            "workspace");
      toast.success(`Moved ${employee.discordName} to ${label}`);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to move employee");
    }
  }

  async function handleCreateWorkspace() {
    const name = newWorkspace.trim();
    if (!name) {
      toast.error("Enter a workspace name");
      return;
    }
    setCreating(true);
    try {
      const result = await createWorkspace(name);
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success(`Created workspace "${name}"`);
      setNewWorkspace("");
      router.refresh();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to create workspace",
      );
    } finally {
      setCreating(false);
    }
  }

  const unassigned = byColumn.get(UNASSIGNED) ?? [];

  return (
    <div className="space-y-4">
      {/* Create-workspace bar */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="flex flex-1 items-center gap-2">
          <Input
            value={newWorkspace}
            onChange={(e) => setNewWorkspace(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleCreateWorkspace();
              }
            }}
            placeholder="New workspace name (e.g. Marketing)"
            maxLength={60}
            disabled={creating}
            className="sm:max-w-xs"
          />
          <Button
            type="button"
            onClick={handleCreateWorkspace}
            disabled={creating}
          >
            <Plus className="size-4" />
            Add workspace
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {employees.length} employee{employees.length === 1 ? "" : "s"} ·{" "}
          {workspaces.length} workspace{workspaces.length === 1 ? "" : "s"}
        </p>
      </div>

      <DndContext
        sensors={sensors}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActiveId(null)}
      >
        <div className="flex gap-4 overflow-x-auto pb-2">
          {/* Unassigned pool — always first. */}
          <Column
            id={UNASSIGNED}
            title="Unassigned"
            cards={unassigned}
            isUnassigned
            onRefresh={() => router.refresh()}
          />

          {workspaces.map((w) => (
            <Column
              key={w.id}
              id={w.id}
              title={w.name}
              cards={byColumn.get(w.id) ?? []}
              onRefresh={() => router.refresh()}
            />
          ))}

          {workspaces.length === 0 && (
            <div className="flex min-w-[260px] items-center justify-center rounded-2xl border border-dashed border-border bg-muted/20 p-6 text-center text-xs text-muted-foreground">
              No workspaces yet. Create one above, then drag employees in.
            </div>
          )}
        </div>

        <DragOverlay>
          {activeEmployee ? (
            <EmployeeCardView employee={activeEmployee} overlay />
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

// ─── Column ──────────────────────────────────────────────────────────

function Column({
  id,
  title,
  cards,
  isUnassigned,
  onRefresh,
}: {
  id: string;
  title: string;
  cards: EmployeeCard[];
  isUnassigned?: boolean;
  onRefresh: () => void;
}) {
  const router = useRouter();
  const { setNodeRef, isOver } = useDroppable({ id });

  const [editing, setEditing] = React.useState(false);
  const [name, setName] = React.useState(title);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    setName(title);
  }, [title]);

  async function handleRename() {
    const next = name.trim();
    if (!next || next === title) {
      setEditing(false);
      setName(title);
      return;
    }
    setSaving(true);
    try {
      const result = await renameWorkspace(id, next);
      if (!result.success) {
        toast.error(result.error);
        setName(title);
        return;
      }
      toast.success("Workspace renamed");
      setEditing(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to rename");
      setName(title);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setSaving(true);
    try {
      const result = await deleteWorkspace(id);
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success("Workspace deleted");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex w-[280px] shrink-0 flex-col rounded-2xl border bg-card shadow-sm transition-colors",
        isOver && "border-primary/50 ring-2 ring-primary/30",
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2 border-b bg-muted/30 px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              "flex size-7 shrink-0 items-center justify-center rounded-lg",
              isUnassigned
                ? "bg-muted text-muted-foreground"
                : "bg-cyan-500/10 text-cyan-500",
            )}
          >
            {isUnassigned ? (
              <Inbox className="size-4" />
            ) : (
              <Users className="size-4" />
            )}
          </span>
          {editing && !isUnassigned ? (
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={handleRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleRename();
                } else if (e.key === "Escape") {
                  setEditing(false);
                  setName(title);
                }
              }}
              maxLength={60}
              disabled={saving}
              className="h-7 text-sm font-semibold"
            />
          ) : (
            <h3
              className={cn(
                "truncate text-sm font-semibold",
                !isUnassigned && "cursor-pointer hover:text-primary",
              )}
              title={isUnassigned ? title : `${title} — double-click to rename`}
              onDoubleClick={() => {
                if (!isUnassigned) setEditing(true);
              }}
            >
              {title}
            </h3>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Badge
            variant="outline"
            className="px-1.5 py-0.5 text-[10px] font-medium leading-none tabular-nums"
          >
            {cards.length}
          </Badge>
          {!isUnassigned && (
            <button
              type="button"
              onClick={handleDelete}
              disabled={saving}
              aria-label={`Delete workspace ${title}`}
              title="Delete workspace (cards return to Unassigned)"
              className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-rose-500/10 hover:text-rose-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              <Trash2 className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Cards */}
      <div className="flex min-h-[120px] flex-1 flex-col gap-2 p-2">
        {cards.length === 0 ? (
          <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-border/60 p-4 text-center text-[11px] text-muted-foreground">
            {isUnassigned ? "Everyone is placed" : "Drag employees here"}
          </div>
        ) : (
          cards.map((card) => (
            <DraggableEmployee
              key={card.id}
              employee={card}
              onRefresh={onRefresh}
            />
          ))
        )}
      </div>
    </div>
  );
}

// ─── Draggable employee wrapper ──────────────────────────────────────

function DraggableEmployee({
  employee,
  onRefresh,
}: {
  employee: EmployeeCard;
  onRefresh: () => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: employee.id,
  });

  return (
    <EmployeeCardView
      employee={employee}
      onRefresh={onRefresh}
      dragRef={setNodeRef}
      dragHandleProps={{ ...attributes, ...listeners }}
      isDragging={isDragging}
    />
  );
}

// ─── Employee card ───────────────────────────────────────────────────

function EmployeeCardView({
  employee,
  onRefresh,
  dragRef,
  dragHandleProps,
  isDragging,
  overlay,
}: {
  employee: EmployeeCard;
  onRefresh?: () => void;
  dragRef?: (node: HTMLElement | null) => void;
  dragHandleProps?: React.HTMLAttributes<HTMLButtonElement>;
  isDragging?: boolean;
  overlay?: boolean;
}) {
  const [addingRole, setAddingRole] = React.useState(false);
  const [role, setRole] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  async function handleAddRole() {
    const value = role.trim();
    if (!value) {
      setAddingRole(false);
      return;
    }
    setBusy(true);
    try {
      const result = await addEmployeeRole(employee.id, value);
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success(`Added role "${value}"`);
      setRole("");
      setAddingRole(false);
      onRefresh?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add role");
    } finally {
      setBusy(false);
    }
  }

  async function handleRemoveRole(target: string) {
    setBusy(true);
    try {
      const result = await removeEmployeeRole(employee.id, target);
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      onRefresh?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove role");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      ref={dragRef}
      className={cn(
        "group rounded-xl border bg-background/60 p-2.5 shadow-sm transition-colors",
        isDragging && "opacity-40",
        overlay && "ring-2 ring-primary/40",
      )}
    >
      <div className="flex items-start gap-2">
        {/* Drag handle — only the handle starts a drag, so clicks on the
            card body (and the role × buttons) stay clickable. */}
        {dragHandleProps ? (
          <button
            type="button"
            aria-label={`Drag ${employee.discordName}`}
            className="mt-0.5 inline-flex size-5 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground/60 transition-colors hover:text-foreground active:cursor-grabbing"
            {...dragHandleProps}
          >
            <GripVertical className="size-4" />
          </button>
        ) : (
          <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center text-muted-foreground/60">
            <GripVertical className="size-4" />
          </span>
        )}

        <div className="min-w-0 flex-1">
          <div
            className="flex items-center gap-1.5"
            onDoubleClick={() => {
              if (onRefresh && !overlay) setAddingRole(true);
            }}
            title={onRefresh ? "Double-click to add a role" : undefined}
          >
            <span className="truncate text-sm font-medium">
              {employee.discordName}
            </span>
            {!employee.active && (
              <Badge
                variant="outline"
                className="shrink-0 px-1.5 py-0 text-[9px] font-medium leading-none text-muted-foreground"
              >
                inactive
              </Badge>
            )}
          </div>

          {/* Role chips */}
          {(employee.roles.length > 0 || addingRole) && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              {employee.roles.map((r) => (
                <Badge
                  key={r}
                  variant="outline"
                  className="flex items-center gap-1 border-cyan-500/30 bg-cyan-500/10 px-1.5 py-0.5 text-[10px] font-medium leading-none text-cyan-600 dark:text-cyan-400"
                >
                  {r}
                  {onRefresh && !overlay && (
                    <button
                      type="button"
                      onClick={() => handleRemoveRole(r)}
                      disabled={busy}
                      aria-label={`Remove role ${r}`}
                      className="hover:text-rose-500 disabled:opacity-50"
                    >
                      <X className="size-2.5" />
                    </button>
                  )}
                </Badge>
              ))}

              {addingRole && onRefresh && !overlay && (
                <span className="inline-flex items-center gap-1">
                  <Input
                    autoFocus
                    value={role}
                    onChange={(e) => setRole(e.target.value)}
                    onBlur={handleAddRole}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleAddRole();
                      } else if (e.key === "Escape") {
                        setAddingRole(false);
                        setRole("");
                      }
                    }}
                    placeholder="Role…"
                    maxLength={40}
                    disabled={busy}
                    className="h-6 w-24 px-1.5 text-[11px]"
                  />
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={handleAddRole}
                    disabled={busy}
                    aria-label="Confirm role"
                    className="inline-flex size-5 items-center justify-center rounded text-emerald-500 hover:bg-emerald-500/10 disabled:opacity-50"
                  >
                    <Check className="size-3" />
                  </button>
                </span>
              )}
            </div>
          )}

          {/* Empty hint — only when no roles and not currently adding. */}
          {employee.roles.length === 0 && !addingRole && onRefresh && !overlay && (
            <button
              type="button"
              onClick={() => setAddingRole(true)}
              className="mt-1 inline-flex items-center gap-1 text-[10px] text-muted-foreground/70 transition-colors hover:text-foreground"
            >
              <Plus className="size-2.5" />
              Add role
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
