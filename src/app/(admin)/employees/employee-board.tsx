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
  useDroppable,
  type DragStartEvent,
  type DragEndEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  arrayMove,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
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
  UserMinus,
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
  movePlacement,
  addEmployeeToWorkspace,
  removePlacement,
  reorderColumn,
  addPlacementRole,
  removePlacementRole,
  addManager,
  removeManager,
  linkManagerWorkspace,
  unlinkManagerWorkspace,
} from "./actions";

// ─── Types ───────────────────────────────────────────────────────────
// Serializable props only — no functions cross the RSC boundary.

// A placement card. `id` is the dnd identity:
//   - real placement → placement uuid (synthetic === false)
//   - unplaced employee in Unassigned → "unplaced:<employeeId>" (synthetic === true)
type PlacementCard = {
  id: string;
  employeeId: string;
  discordName: string;
  active: boolean;
  workspaceId: string | null;
  roles: string[];
  position: number;
  synthetic: boolean;
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

// An employee eligible to be added to a workspace via "+ Add member".
type Placeable = {
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
  cards,
  workspaces,
  managers,
  managerCandidates,
  placeableEmployees,
}: {
  cards: PlacementCard[];
  workspaces: Workspace[];
  managers: Manager[];
  managerCandidates: ManagerCandidate[];
  placeableEmployees: Placeable[];
}) {
  const router = useRouter();
  const sensors = useSensors(
    useSensor(PointerSensor, {
      // Small activation distance so a click (to add a role) isn't
      // swallowed as the start of a drag.
      activationConstraint: { distance: 6 },
    }),
  );

  // Local optimistic state so a drag-reorder doesn't flicker the column
  // back to its old order while the server roundtrip is in flight. We
  // re-sync to the server data on every refresh (it's authoritative).
  const [localCards, setLocalCards] = React.useState(cards);
  React.useEffect(() => {
    setLocalCards(cards);
  }, [cards]);

  const [activeId, setActiveId] = React.useState<string | null>(null);
  // The column the active card lived in BEFORE drag started. We need a
  // separate ref because handleDragOver optimistically rewrites
  // card.workspaceId, which would otherwise destroy the source-column
  // info by the time handleDragEnd runs.
  const dragSourceColumnRef = React.useRef<string | null>(null);

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

  // Group cards by column key (UNASSIGNED for null workspace). Already
  // sorted by `position` from the server; preserve that order.
  const byColumn = React.useMemo(() => {
    const map = new Map<string, PlacementCard[]>();
    map.set(UNASSIGNED, []);
    for (const w of workspaces) map.set(w.id, []);
    for (const c of localCards) {
      const key = c.workspaceId && map.has(c.workspaceId) ? c.workspaceId : UNASSIGNED;
      map.get(key)!.push(c);
    }
    // Synthetic unplaced cards have position = MAX_SAFE_INTEGER so they
    // sit at the bottom of Unassigned by default; everything else uses
    // server-provided position.
    for (const list of map.values()) {
      list.sort((a, b) => a.position - b.position);
    }
    return map;
  }, [localCards, workspaces]);

  const cardById = React.useMemo(
    () => new Map(localCards.map((c) => [c.id, c])),
    [localCards],
  );

  const activeCard = activeId ? cardById.get(activeId) ?? null : null;

  // Helper: find which column a card id is currently in (using local
  // state). Returns the column key (UNASSIGNED or a workspace id).
  function columnKeyOf(cardId: string): string | null {
    const c = cardById.get(cardId);
    if (!c) return null;
    return c.workspaceId && byColumn.has(c.workspaceId) ? c.workspaceId : UNASSIGNED;
  }

  // ── DnD handlers ────────────────────────────────────────────────────

  function handleDragStart(event: DragStartEvent) {
    const id = String(event.active.id);
    setActiveId(id);
    // Capture the source column from the AUTHORITATIVE props (not the
    // optimistic localCards), so handleDragEnd can tell a real
    // cross-column move from a same-column reorder even after dragOver
    // has shuffled card.workspaceId for the optimistic visual.
    const original = cards.find((c) => c.id === id);
    dragSourceColumnRef.current = original
      ? original.workspaceId && workspaces.some((w) => w.id === original.workspaceId)
        ? original.workspaceId
        : UNASSIGNED
      : null;
  }

  // During drag-over, optimistically reflow the local state so the card
  // visibly slots into the new position before the drop. The server
  // request fires only on drag-end so we don't spam mid-drag.
  function handleDragOver(event: DragOverEvent) {
    const { active, over } = event;
    if (!over) return;
    const activeKey = columnKeyOf(String(active.id));
    if (activeKey === null) return;

    const overId = String(over.id);
    // Dropping on a column container directly → move to the end of it.
    const overColumnKey = overId.startsWith("col:")
      ? overId.slice(4)
      : columnKeyOf(overId);
    if (overColumnKey === null) return;

    if (activeKey === overColumnKey) {
      // Same column reorder is handled fully on drag-end (we want the
      // ghost to track the pointer without thrashing array order).
      return;
    }

    // Cross-column hover: reflect the column change locally so the
    // empty/filled column visuals update during the hover.
    setLocalCards((prev) => {
      const idx = prev.findIndex((c) => c.id === String(active.id));
      if (idx < 0) return prev;
      const card = prev[idx];
      const nextWorkspace = overColumnKey === UNASSIGNED ? null : overColumnKey;
      if (card.workspaceId === nextWorkspace) return prev;
      const next = prev.slice();
      next[idx] = { ...card, workspaceId: nextWorkspace };
      return next;
    });
  }

  async function handleDragEnd(event: DragEndEvent) {
    const activeIdLocal = activeId;
    const sourceFromStart = dragSourceColumnRef.current;
    setActiveId(null);
    dragSourceColumnRef.current = null;
    const { active, over } = event;
    if (!over || !activeIdLocal) {
      // Drop outside any droppable. The optimistic dragOver mutation
      // is still in localCards; sync back to the authoritative server
      // state so the card snaps home.
      router.refresh();
      return;
    }

    const card = cardById.get(String(active.id));
    if (!card) return;

    const overId = String(over.id);
    const overColumnKey = overId.startsWith("col:")
      ? overId.slice(4)
      : columnKeyOf(overId);
    if (overColumnKey === null) return;

    const targetWorkspaceId = overColumnKey === UNASSIGNED ? null : overColumnKey;

    // ── Synthetic card (no placement row yet) ─────────────────────
    // Synthetic cards START in Unassigned (workspaceId === null), but
    // handleDragOver optimistically rewrites card.workspaceId to the
    // hovered column to update the visuals. That means we CANNOT trust
    // card.workspaceId to figure out the real source — using it makes
    // sourceColumnKey === overColumnKey and the same-column reorder
    // branch swallows the drop without ever calling the server, so the
    // optimistic state lies (employee LOOKS placed) until the next
    // router.refresh clears it (e.g. when a new workspace is created),
    // at which point the user sees "all my placements disappeared".
    // Synthetic + drop on a real workspace → always create a placement.
    if (card.synthetic) {
      if (targetWorkspaceId === null) {
        // Synthetic → Unassigned is a no-op. Re-sync so any optimistic
        // dragOver mutation that moved the card into a workspace gets
        // reverted to its true Unassigned home.
        router.refresh();
        return;
      }
      try {
        const res = await addEmployeeToWorkspace(
          card.employeeId,
          targetWorkspaceId,
        );
        if (!res.success) {
          toast.error(res.error);
          router.refresh();
          return;
        }
        const label =
          workspaces.find((w) => w.id === targetWorkspaceId)?.name ??
          "workspace";
        toast.success(`Added ${card.discordName} to ${label}`);
        router.refresh();
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to add employee",
        );
        router.refresh();
      }
      return;
    }

    // Real placements: trust the source column captured at dragStart,
    // not the optimistic card.workspaceId. handleDragOver rewrites that
    // for the in-flight visual, so a ws1 → ws2 drag would otherwise read
    // sourceColumnKey = ws2 (the optimistic target), match overColumnKey,
    // and incorrectly enter the same-column reorder branch — making
    // every cross-column drag fall over the reorderColumn guard.
    const sourceColumnKey =
      sourceFromStart ??
      (card.workspaceId && byColumn.has(card.workspaceId)
        ? card.workspaceId
        : UNASSIGNED);

    // ── Same-column reorder ───────────────────────────────────────
    if (sourceColumnKey === overColumnKey) {
      // Drop directly on a card → place active before/after it.
      // Drop on the column container → put at the end.
      const list = byColumn.get(sourceColumnKey) ?? [];
      const fromIdx = list.findIndex((c) => c.id === String(active.id));
      let toIdx = list.length - 1;
      if (!overId.startsWith("col:")) {
        const i = list.findIndex((c) => c.id === overId);
        if (i >= 0) toIdx = i;
      }
      if (fromIdx < 0 || toIdx === fromIdx) return;

      const reordered = arrayMove(list, fromIdx, toIdx);

      // Synthetic (unplaced) cards can't be ordered server-side — they
      // don't have a placement row yet. Filter them out; remaining real
      // placements get fresh positions.
      const realIds = reordered.filter((c) => !c.synthetic).map((c) => c.id);

      // Optimistic update.
      setLocalCards((prev) => {
        const updated = prev.slice();
        // Patch positions for everything in this column to match the new order.
        reordered.forEach((c, i) => {
          const idx = updated.findIndex((u) => u.id === c.id);
          if (idx >= 0) updated[idx] = { ...updated[idx], position: i };
        });
        return updated;
      });

      if (realIds.length === 0) return; // nothing to persist (all synthetic)

      try {
        const res = await reorderColumn(targetWorkspaceId, realIds);
        if (!res.success) {
          toast.error(res.error);
          router.refresh();
          return;
        }
        // Don't refresh on success — local state already matches.
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to reorder",
        );
        router.refresh();
      }
      return;
    }

    // ── Cross-column move (real placement) ────────────────────────
    // Synthetic cards are already handled above. Anything reaching here
    // is a real placement row being moved between columns.
    try {
      const res = await movePlacement(card.id, targetWorkspaceId);
      if (!res.success) {
        toast.error(res.error);
        router.refresh();
        return;
      }
      const label =
        targetWorkspaceId === null
          ? "Unassigned"
          : workspaces.find((w) => w.id === targetWorkspaceId)?.name ??
            "workspace";
      toast.success(`Moved ${card.discordName} to ${label}`);
      router.refresh();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to move employee",
      );
      router.refresh();
    }
  }

  // ── Create-workspace ─────────────────────────────────────────────

  const [newWorkspace, setNewWorkspace] = React.useState("");
  const [creating, setCreating] = React.useState(false);

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
          {placeableEmployees.length} employee
          {placeableEmployees.length === 1 ? "" : "s"} ·{" "}
          {workspaces.length} workspace{workspaces.length === 1 ? "" : "s"}
        </p>
      </div>

      <DndContext
        sensors={sensors}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={() => {
          setActiveId(null);
          dragSourceColumnRef.current = null;
          // Drop outside any droppable: revert the optimistic dragOver
          // mutation by snapping back to the authoritative server state.
          router.refresh();
        }}
      >
        <div className="overflow-x-auto pb-2">
          <div ref={wrapperRef} className="relative min-w-max">
            {/* Connector-line layer — sits behind the blocks (z-0). */}
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

            {/* Manager row */}
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

            {/* Columns row */}
            <div className="relative z-10 flex gap-4">
              <Column
                id={UNASSIGNED}
                title="Unassigned"
                cards={unassigned}
                isUnassigned
                onRefresh={() => router.refresh()}
                placeableEmployees={placeableEmployees}
              />

              {workspaces.map((w) => {
                const list = byColumn.get(w.id) ?? [];
                const placedIds = new Set(list.map((c) => c.employeeId));
                const addable = placeableEmployees.filter(
                  (e) => !placedIds.has(e.id),
                );
                return (
                  <Column
                    key={w.id}
                    id={w.id}
                    title={w.name}
                    cards={list}
                    onRefresh={() => router.refresh()}
                    registerMeasure={setColumnRef}
                    placeableEmployees={addable}
                  />
                );
              })}

              {workspaces.length === 0 && (
                <div className="flex min-w-[260px] items-center justify-center rounded-2xl border border-dashed border-border bg-muted/20 p-6 text-center text-xs text-muted-foreground">
                  No workspaces yet. Create one above, then drag employees
                  in.
                </div>
              )}
            </div>
          </div>
        </div>

        <DragOverlay>
          {activeCard ? (
            <EmployeeCardView card={activeCard} overlay />
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
  placeableEmployees,
}: {
  id: string;
  title: string;
  cards: PlacementCard[];
  isUnassigned?: boolean;
  onRefresh: () => void;
  registerMeasure?: (id: string, node: HTMLElement | null) => void;
  placeableEmployees: Placeable[];
}) {
  const router = useRouter();
  // The droppable id is prefixed with `col:` so DnD handlers can tell
  // "dropped on column container" apart from "dropped on a card", which
  // share the same number space.
  const { setNodeRef, isOver } = useDroppable({ id: `col:${id}` });

  // Merge the dnd-kit droppable ref with the measure ref so the same DOM
  // node feeds both.
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

  async function handleAdd(employeeId: string) {
    if (isUnassigned) return; // can't "add" to the implicit pool
    try {
      const res = await addEmployeeToWorkspace(employeeId, id);
      if (!res.success) {
        toast.error(res.error);
        return;
      }
      toast.success("Added to section");
      router.refresh();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to add member",
      );
    }
  }

  // SortableContext needs the list of ids in order. Includes synthetic
  // ids so dragging an unplaced card into another column still works.
  const cardIds = React.useMemo(() => cards.map((c) => c.id), [cards]);

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
              title={
                isUnassigned ? title : `${title} — double-click to rename`
              }
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
            <>
              {/* Add member dropdown — placeholder filtered to only show
                  employees not yet placed in this section. */}
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <button
                      type="button"
                      aria-label={`Add member to ${title}`}
                      title="Add a member to this section"
                      className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-emerald-500/10 hover:text-emerald-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  }
                >
                  <Plus className="size-3.5" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="max-h-72 w-56">
                  {placeableEmployees.length === 0 ? (
                    <DropdownMenuItem disabled>
                      Everyone is already in this section
                    </DropdownMenuItem>
                  ) : (
                    placeableEmployees.map((e) => (
                      <DropdownMenuItem
                        key={e.id}
                        onClick={() => handleAdd(e.id)}
                      >
                        <span className="truncate">{e.discordName}</span>
                        {!e.active && (
                          <span className="ml-auto text-[10px] text-muted-foreground">
                            inactive
                          </span>
                        )}
                      </DropdownMenuItem>
                    ))
                  )}
                </DropdownMenuContent>
              </DropdownMenu>

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
            </>
          )}
        </div>
      </div>

      {/* Cards */}
      <SortableContext items={cardIds} strategy={verticalListSortingStrategy}>
        <div className="flex min-h-[120px] flex-1 flex-col gap-2 p-2">
          {cards.length === 0 ? (
            <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-border/60 p-4 text-center text-[11px] text-muted-foreground">
              {isUnassigned ? "Everyone is placed" : "Drop a member here"}
            </div>
          ) : (
            cards.map((card) => (
              <SortableCard key={card.id} card={card} onRefresh={onRefresh} />
            ))
          )}
        </div>
      </SortableContext>
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
      toast.error(
        err instanceof Error ? err.message : "Failed to link section",
      );
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
      toast.error(
        err instanceof Error ? err.message : "Failed to add manager",
      );
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

// ─── Sortable employee card ──────────────────────────────────────────

function SortableCard({
  card,
  onRefresh,
}: {
  card: PlacementCard;
  onRefresh: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: card.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <EmployeeCardView
      card={card}
      onRefresh={onRefresh}
      dragRef={setNodeRef}
      dragHandleProps={{ ...attributes, ...listeners }}
      isDragging={isDragging}
      style={style}
    />
  );
}

// ─── Employee card ───────────────────────────────────────────────────

function EmployeeCardView({
  card,
  onRefresh,
  dragRef,
  dragHandleProps,
  isDragging,
  overlay,
  style,
}: {
  card: PlacementCard;
  onRefresh?: () => void;
  dragRef?: (node: HTMLElement | null) => void;
  dragHandleProps?: React.HTMLAttributes<HTMLButtonElement>;
  isDragging?: boolean;
  overlay?: boolean;
  style?: React.CSSProperties;
}) {
  const router = useRouter();
  const [addingRole, setAddingRole] = React.useState(false);
  const [role, setRole] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  // Roles + remove-from-section operate on the placement id. Synthetic
  // cards (employee not yet placed) hide both controls — they need a
  // real placement row first, which is created by dragging into a
  // workspace or via the column's "+ Add member" button.
  const canEditPlacement = !card.synthetic && !overlay && !!onRefresh;

  async function handleAddRole() {
    const value = role.trim();
    if (!value) {
      setAddingRole(false);
      return;
    }
    if (!canEditPlacement) {
      toast.error("Place this employee in a section first");
      setAddingRole(false);
      return;
    }
    setBusy(true);
    try {
      const result = await addPlacementRole(card.id, value);
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
    if (!canEditPlacement) return;
    setBusy(true);
    try {
      const result = await removePlacementRole(card.id, target);
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      onRefresh?.();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to remove role",
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleRemoveFromSection() {
    if (!canEditPlacement) return;
    setBusy(true);
    try {
      const result = await removePlacement(card.id);
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success(`Removed from section`);
      onRefresh?.();
      router.refresh();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to remove from section",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      ref={dragRef}
      style={style}
      className={cn(
        "group rounded-xl border bg-background/60 p-2.5 shadow-sm transition-colors",
        isDragging && "opacity-40",
        overlay && "ring-2 ring-primary/40",
      )}
    >
      <div className="flex items-start gap-2">
        {/* Drag handle */}
        {dragHandleProps ? (
          <button
            type="button"
            aria-label={`Drag ${card.discordName}`}
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
              if (canEditPlacement) setAddingRole(true);
            }}
            title={
              canEditPlacement ? "Double-click to add a role" : undefined
            }
          >
            <span className="truncate text-sm font-medium">
              {card.discordName}
            </span>
            {!card.active && (
              <Badge
                variant="outline"
                className="shrink-0 px-1.5 py-0 text-[9px] font-medium leading-none text-muted-foreground"
              >
                inactive
              </Badge>
            )}
          </div>

          {/* Role chips */}
          {(card.roles.length > 0 || addingRole) && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              {card.roles.map((r) => (
                <Badge
                  key={r}
                  variant="outline"
                  className="flex items-center gap-1 border-cyan-500/30 bg-cyan-500/10 px-1.5 py-0.5 text-[10px] font-medium leading-none text-cyan-600 dark:text-cyan-400"
                >
                  {r}
                  {canEditPlacement && (
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

              {addingRole && canEditPlacement && (
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

          {/* Empty hint */}
          {card.roles.length === 0 && !addingRole && canEditPlacement && (
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

        {/* Remove-from-section button — only on real placements that
            sit in a real workspace (Unassigned is the implicit pool;
            "removing" from there is a no-op). */}
        {canEditPlacement && card.workspaceId && (
          <button
            type="button"
            onClick={handleRemoveFromSection}
            disabled={busy}
            aria-label={`Remove ${card.discordName} from this section`}
            title="Remove from this section"
            className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/50 opacity-0 transition-all hover:bg-rose-500/10 hover:text-rose-500 focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-30"
          >
            <UserMinus className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
