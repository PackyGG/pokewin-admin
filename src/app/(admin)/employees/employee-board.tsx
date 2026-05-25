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
  UserCog,
  UserPlus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  createWorkspace,
  renameWorkspace,
  deleteWorkspace,
  moveEmployee,
  addEmployeeRole,
  removeEmployeeRole,
  addManager,
  removeManager,
  linkManagerWorkspace,
  unlinkManagerWorkspace,
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

// A manager block (row above the columns). employeeId is the underlying
// salary employee; workspaceIds are the sections it's linked to — one
// connector line per id.
type Manager = {
  id: string;
  employeeId: string;
  discordName: string;
  active: boolean;
  workspaceIds: string[];
};

// An employee eligible to be promoted to manager.
type ManagerCandidate = {
  id: string;
  discordName: string;
  active: boolean;
};

// A computed connector line from a manager to one of its workspaces.
type ConnectorLine = {
  id: string;
  d: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

// Sentinel column id for the Unassigned pool (workspaceId === null).
const UNASSIGNED = "__unassigned__";

// ─── Board ───────────────────────────────────────────────────────────

export function EmployeeBoard({
  employees,
  workspaces,
  managers,
  managerCandidates,
}: {
  employees: EmployeeCard[];
  workspaces: Workspace[];
  managers: Manager[];
  managerCandidates: ManagerCandidate[];
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

  // ── Connector lines (manager → workspace) ───────────────────────────
  // We measure the live DOM positions of each manager block and each
  // workspace column relative to the board wrapper, then draw an SVG
  // bezier between them. Coordinates are rect-diffs against the wrapper,
  // so they stay correct while the wrapper scrolls horizontally (the SVG
  // lives inside the same scrolling wrapper).
  const wrapperRef = React.useRef<HTMLDivElement | null>(null);
  const managerRefs = React.useRef(new Map<string, HTMLElement>());
  const columnRefs = React.useRef(new Map<string, HTMLElement>());
  const [lines, setLines] = React.useState<ConnectorLine[]>([]);

  const setManagerRef = React.useCallback(
    (id: string, node: HTMLElement | null) => {
      if (node) managerRefs.current.set(id, node);
      else managerRefs.current.delete(id);
    },
    [],
  );
  const setColumnRef = React.useCallback(
    (id: string, node: HTMLElement | null) => {
      if (node) columnRefs.current.set(id, node);
      else columnRefs.current.delete(id);
    },
    [],
  );

  const recomputeLines = React.useCallback(() => {
    const wrap = wrapperRef.current;
    if (!wrap) return;
    const wr = wrap.getBoundingClientRect();
    const validWorkspace = new Set(workspaces.map((w) => w.id));
    const next: ConnectorLine[] = [];
    for (const m of managers) {
      const mEl = managerRefs.current.get(m.id);
      if (!mEl) continue;
      const mr = mEl.getBoundingClientRect();
      const x1 = mr.left - wr.left + mr.width / 2;
      const y1 = mr.bottom - wr.top;
      for (const wid of m.workspaceIds) {
        if (!validWorkspace.has(wid)) continue;
        const cEl = columnRefs.current.get(wid);
        if (!cEl) continue;
        const cr = cEl.getBoundingClientRect();
        const x2 = cr.left - wr.left + cr.width / 2;
        const y2 = cr.top - wr.top;
        const midY = y1 + (y2 - y1) / 2;
        const d = `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
        next.push({ id: `${m.id}-${wid}`, d, x1, y1, x2, y2 });
      }
    }
    setLines(next);
  }, [managers, workspaces]);

  // Position lines before paint, then keep them in sync with any layout
  // change: window resize, and wrapper/column/manager box resizes (e.g. a
  // role chip wraps and pushes the columns down). recomputeLines changes
  // identity on every data refresh (managers/workspaces get fresh array
  // identities each server render), so these effects also re-run then.
  React.useLayoutEffect(() => {
    recomputeLines();
  }, [recomputeLines]);

  React.useEffect(() => {
    const wrap = wrapperRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => recomputeLines());
    ro.observe(wrap);
    managerRefs.current.forEach((el) => ro.observe(el));
    columnRefs.current.forEach((el) => ro.observe(el));
    window.addEventListener("resize", recomputeLines);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", recomputeLines);
    };
  }, [recomputeLines]);

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
        <div className="overflow-x-auto pb-2">
          <div ref={wrapperRef} className="relative min-w-max">
            {/* Connector-line layer — sits behind the blocks (z-0) so the
                lines visibly emerge from the manager/column edges. */}
            <svg
              className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
              aria-hidden
            >
              {lines.map((l) => (
                <g key={l.id}>
                  <path
                    d={l.d}
                    className="fill-none stroke-cyan-500/45 dark:stroke-cyan-400/45"
                    strokeWidth={1.5}
                  />
                  <circle
                    cx={l.x1}
                    cy={l.y1}
                    r={3}
                    className="fill-cyan-500/80 dark:fill-cyan-400/80"
                  />
                  <circle
                    cx={l.x2}
                    cy={l.y2}
                    r={3}
                    className="fill-cyan-500/80 dark:fill-cyan-400/80"
                  />
                </g>
              ))}
            </svg>

            {/* Manager row — the "section heads" above the columns. */}
            <div className="relative z-10 mb-10 flex items-start gap-3">
              {managers.map((m) => (
                <ManagerBlock
                  key={m.id}
                  manager={m}
                  workspaces={workspaces}
                  registerRef={setManagerRef}
                  onRefresh={() => router.refresh()}
                />
              ))}
              <AddManagerControl
                candidates={managerCandidates}
                onRefresh={() => router.refresh()}
              />
            </div>

            {/* Columns row. */}
            <div className="relative z-10 flex gap-4">
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
                  registerMeasure={setColumnRef}
                />
              ))}

              {workspaces.length === 0 && (
                <div className="flex min-w-[260px] items-center justify-center rounded-2xl border border-dashed border-border bg-muted/20 p-6 text-center text-xs text-muted-foreground">
                  No workspaces yet. Create one above, then drag employees in.
                </div>
              )}
            </div>
          </div>
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
  registerMeasure,
}: {
  id: string;
  title: string;
  cards: EmployeeCard[];
  isUnassigned?: boolean;
  onRefresh: () => void;
  // Real workspaces register their DOM node so the board can anchor
  // connector lines to the column's top-center. Omitted for Unassigned.
  registerMeasure?: (id: string, node: HTMLElement | null) => void;
}) {
  const router = useRouter();
  const { setNodeRef, isOver } = useDroppable({ id });

  // Merge the dnd-kit droppable ref with the measure ref so the same DOM
  // node feeds both. Stable identity (deps are all stable) avoids ref
  // churn across renders.
  const setRefs = React.useCallback(
    (node: HTMLDivElement | null) => {
      setNodeRef(node);
      registerMeasure?.(id, node);
    },
    [setNodeRef, registerMeasure, id],
  );

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
      ref={setRefs}
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

// ─── Manager block (row above the columns) ───────────────────────────

function ManagerBlock({
  manager,
  workspaces,
  registerRef,
  onRefresh,
}: {
  manager: Manager;
  workspaces: Workspace[];
  registerRef: (id: string, node: HTMLElement | null) => void;
  onRefresh: () => void;
}) {
  const [busy, setBusy] = React.useState(false);

  // Stable callback ref (deps stable) — no churn across renders.
  const ref = React.useCallback(
    (node: HTMLDivElement | null) => registerRef(manager.id, node),
    [registerRef, manager.id],
  );

  const linkedSet = new Set(manager.workspaceIds);
  const linked = workspaces.filter((w) => linkedSet.has(w.id));
  const unlinked = workspaces.filter((w) => !linkedSet.has(w.id));

  async function handleLink(workspaceId: string) {
    setBusy(true);
    try {
      const res = await linkManagerWorkspace(manager.id, workspaceId);
      if (!res.success) {
        toast.error(res.error);
        return;
      }
      onRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to link section");
    } finally {
      setBusy(false);
    }
  }

  async function handleUnlink(workspaceId: string) {
    setBusy(true);
    try {
      const res = await unlinkManagerWorkspace(manager.id, workspaceId);
      if (!res.success) {
        toast.error(res.error);
        return;
      }
      onRefresh();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to unlink section",
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove() {
    setBusy(true);
    try {
      const res = await removeManager(manager.id);
      if (!res.success) {
        toast.error(res.error);
        return;
      }
      toast.success(`Removed ${manager.discordName} as manager`);
      onRefresh();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to remove manager",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      ref={ref}
      className="w-[240px] shrink-0 rounded-2xl border border-violet-500/30 bg-violet-500/5 p-3 shadow-sm"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-violet-500/15 text-violet-500">
            <UserCog className="size-4" />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-semibold">
                {manager.discordName}
              </span>
              {!manager.active && (
                <Badge
                  variant="outline"
                  className="shrink-0 px-1.5 py-0 text-[9px] font-medium leading-none text-muted-foreground"
                >
                  inactive
                </Badge>
              )}
            </div>
            <span className="text-[10px] font-medium uppercase tracking-wide text-violet-500/80">
              Manager
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={handleRemove}
          disabled={busy}
          aria-label={`Remove ${manager.discordName} as manager`}
          title="Remove manager (returns them to the board)"
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-rose-500/10 hover:text-rose-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          <X className="size-3.5" />
        </button>
      </div>

      {/* Linked sections (one chip per connector line) + link control. */}
      <div className="mt-2 flex flex-wrap items-center gap-1">
        {linked.map((w) => (
          <Badge
            key={w.id}
            variant="outline"
            className="flex items-center gap-1 border-violet-500/30 bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-medium leading-none text-violet-600 dark:text-violet-400"
          >
            {w.name}
            <button
              type="button"
              onClick={() => handleUnlink(w.id)}
              disabled={busy}
              aria-label={`Unlink ${w.name}`}
              className="hover:text-rose-500 disabled:opacity-50"
            >
              <X className="size-2.5" />
            </button>
          </Badge>
        ))}

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                disabled={busy}
                className="inline-flex items-center gap-1 rounded-md border border-dashed border-violet-500/40 px-1.5 py-0.5 text-[10px] font-medium text-violet-500 transition-colors hover:bg-violet-500/10 disabled:opacity-50"
              />
            }
          >
            <Plus className="size-2.5" />
            Link section
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-64 w-48">
            {unlinked.length === 0 ? (
              <DropdownMenuItem disabled>
                {workspaces.length === 0
                  ? "No sections yet"
                  : "All sections linked"}
              </DropdownMenuItem>
            ) : (
              unlinked.map((w) => (
                <DropdownMenuItem key={w.id} onClick={() => handleLink(w.id)}>
                  <span className="truncate">{w.name}</span>
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

// ─── Add-manager control ─────────────────────────────────────────────

function AddManagerControl({
  candidates,
  onRefresh,
}: {
  candidates: ManagerCandidate[];
  onRefresh: () => void;
}) {
  const [busy, setBusy] = React.useState(false);

  async function handleAdd(employeeId: string) {
    setBusy(true);
    try {
      const res = await addManager(employeeId);
      if (!res.success) {
        toast.error(res.error);
        return;
      }
      toast.success("Manager added");
      onRefresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add manager");
    } finally {
      setBusy(false);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            disabled={busy}
            className="flex h-[92px] w-[200px] shrink-0 flex-col items-center justify-center gap-1.5 rounded-2xl border border-dashed border-violet-500/40 bg-violet-500/[0.03] text-violet-500 transition-colors hover:bg-violet-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          />
        }
      >
        <UserPlus className="size-5" />
        <span className="text-xs font-medium">Add manager</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 w-56">
        {candidates.length === 0 ? (
          <DropdownMenuItem disabled>No employees available</DropdownMenuItem>
        ) : (
          candidates.map((c) => (
            <DropdownMenuItem key={c.id} onClick={() => handleAdd(c.id)}>
              <span className="truncate">{c.discordName}</span>
              {!c.active && (
                <span className="ml-auto text-[10px] text-muted-foreground">
                  inactive
                </span>
              )}
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
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
