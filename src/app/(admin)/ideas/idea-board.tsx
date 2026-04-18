"use client";

import * as React from "react";
import {
  Plus,
  Trash2,
  Pencil,
  Lightbulb,
  Circle,
  CheckCircle2,
  XCircle,
  Maximize2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import {
  createIdea,
  deleteIdea,
  setIdeaStatus,
  updateIdea,
  updateIdeaPosition,
} from "./actions";
import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  CARD_HEIGHT,
  CARD_WIDTH,
  NEXT_STATUS,
  type Idea,
  type IdeaStatus,
} from "./types";

// ─── Status → style mapping ──────────────────────────────────────

const STATUS_STYLES: Record<
  IdeaStatus,
  {
    border: string;
    glow: string;
    chip: string;
    chipHover: string;
    label: string;
    Icon: React.ComponentType<{ className?: string }>;
  }
> = {
  neutral: {
    border: "border-border",
    glow: "",
    chip: "bg-muted text-muted-foreground ring-1 ring-border",
    chipHover: "hover:bg-muted/80",
    label: "Neutral",
    Icon: Circle,
  },
  green: {
    border: "border-emerald-500/60",
    glow: "shadow-[0_0_28px_-8px_rgba(16,185,129,0.55)]",
    chip: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 ring-1 ring-emerald-500/40",
    chipHover: "hover:bg-emerald-500/25",
    label: "Go",
    Icon: CheckCircle2,
  },
  red: {
    border: "border-rose-500/60",
    glow: "shadow-[0_0_28px_-8px_rgba(244,63,94,0.55)]",
    chip: "bg-rose-500/15 text-rose-600 dark:text-rose-400 ring-1 ring-rose-500/40",
    chipHover: "hover:bg-rose-500/25",
    label: "Kill",
    Icon: XCircle,
  },
};

// Movement below this threshold (in screen pixels) counts as a click,
// not a drag. Keeps a quick tap on the card from scribbling it by a
// pixel and firing an unnecessary server save.
const DRAG_THRESHOLD_PX = 4;

// ─── Board ───────────────────────────────────────────────────────

export function IdeaBoard({ initial }: { initial: Idea[] }) {
  const [ideas, setIdeas] = React.useState<Idea[]>(initial);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Idea | null>(null);
  const [deleting, setDeleting] = React.useState<Idea | null>(null);
  const [pendingStatusId, setPendingStatusId] = React.useState<string | null>(
    null,
  );
  // Card id that's currently being dragged — we bump its z-index so it
  // sits on top of everything else during the drag.
  const [activeId, setActiveId] = React.useState<string | null>(null);

  const canvasRef = React.useRef<HTMLDivElement | null>(null);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);

  // Keep local state in sync when the server-loaded prop changes
  // (router.refresh after create/delete/edit).
  React.useEffect(() => {
    setIdeas(initial);
  }, [initial]);

  // Centre the scroll viewport on the initial cluster of cards so the
  // user lands on the content instead of an empty canvas corner.
  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (ideas.length === 0) {
      // Centre on (0, 0)-ish for the empty state.
      el.scrollTo({ left: 0, top: 0 });
      return;
    }
    // Find the centroid of the current cards and scroll there.
    let sumX = 0;
    let sumY = 0;
    for (const i of ideas) {
      sumX += i.positionX + CARD_WIDTH / 2;
      sumY += i.positionY + CARD_HEIGHT / 2;
    }
    const cx = sumX / ideas.length;
    const cy = sumY / ideas.length;
    el.scrollTo({
      left: Math.max(0, cx - el.clientWidth / 2),
      top: Math.max(0, cy - el.clientHeight / 2),
    });
    // Only run on mount — if we re-ran every time `ideas` changes we'd
    // yank the user's viewport around on every edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function setPositionLocal(id: string, x: number, y: number) {
    setIdeas((list) =>
      list.map((i) => (i.id === id ? { ...i, positionX: x, positionY: y } : i)),
    );
  }

  async function saveStatus(idea: Idea) {
    const target = NEXT_STATUS[idea.status];
    const prev = ideas;
    setPendingStatusId(idea.id);
    setIdeas((list) =>
      list.map((i) => (i.id === idea.id ? { ...i, status: target } : i)),
    );
    const result = await setIdeaStatus({ id: idea.id, status: target });
    setPendingStatusId(null);
    if (!result.success) {
      toast.error(result.error);
      setIdeas(prev);
    }
  }

  async function savePosition(
    id: string,
    x: number,
    y: number,
    original: { x: number; y: number },
  ) {
    const result = await updateIdeaPosition({ id, x, y });
    if (!result.success) {
      toast.error(result.error);
      // Roll back just this card's position.
      setIdeas((list) =>
        list.map((i) =>
          i.id === id
            ? { ...i, positionX: original.x, positionY: original.y }
            : i,
        ),
      );
    }
  }

  function recenter() {
    const el = scrollRef.current;
    if (!el) return;
    if (ideas.length === 0) {
      el.scrollTo({ left: 0, top: 0, behavior: "smooth" });
      return;
    }
    let sumX = 0;
    let sumY = 0;
    for (const i of ideas) {
      sumX += i.positionX + CARD_WIDTH / 2;
      sumY += i.positionY + CARD_HEIGHT / 2;
    }
    const cx = sumX / ideas.length;
    const cy = sumY / ideas.length;
    el.scrollTo({
      left: Math.max(0, cx - el.clientWidth / 2),
      top: Math.max(0, cy - el.clientHeight / 2),
      behavior: "smooth",
    });
  }

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>
            {ideas.length} idea{ideas.length === 1 ? "" : "s"} ·{" "}
            {ideas.filter((i) => i.status === "green").length} go ·{" "}
            {ideas.filter((i) => i.status === "red").length} kill
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={recenter}
            disabled={ideas.length === 0}
          >
            <Maximize2 className="size-4" />
            Recenter
          </Button>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            New idea
          </Button>
        </div>
      </div>

      {/* Scroll viewport */}
      <div
        ref={scrollRef}
        className={cn(
          "relative h-[75vh] min-h-[560px] overflow-auto rounded-2xl border bg-background",
          // Subtle dot grid — vocab-match with Excalidraw-style canvases.
          "[background-image:radial-gradient(circle,var(--muted-foreground)_0.6px,transparent_0.6px)] [background-size:24px_24px]",
          "[background-position:0_0]",
        )}
        // Scope the custom cursor when dragging a card over the canvas
        // — gives the whole viewport a "grabbing" feel instead of just
        // the card.
        style={activeId ? { cursor: "grabbing" } : undefined}
      >
        {/* Canvas */}
        <div
          ref={canvasRef}
          className="relative"
          style={{
            width: CANVAS_WIDTH,
            height: CANVAS_HEIGHT,
          }}
        >
          {ideas.map((idea) => (
            <CanvasCard
              key={idea.id}
              idea={idea}
              active={activeId === idea.id}
              pendingStatus={pendingStatusId === idea.id}
              onActiveChange={(active) =>
                setActiveId(active ? idea.id : null)
              }
              onPositionLocal={(x, y) => setPositionLocal(idea.id, x, y)}
              onPositionCommit={(x, y, original) =>
                savePosition(idea.id, x, y, original)
              }
              onCycleStatus={() => saveStatus(idea)}
              onEdit={() => setEditing(idea)}
              onDelete={() => setDeleting(idea)}
            />
          ))}
        </div>

        {ideas.length === 0 && (
          <EmptyState
            onNew={() => setCreateOpen(true)}
            // Anchor the empty state to the top-left visible area so it
            // shows up regardless of the canvas size.
          />
        )}
      </div>

      <CreateDialog open={createOpen} onOpenChange={setCreateOpen} />
      <EditDialog
        idea={editing}
        onOpenChange={(open) => !open && setEditing(null)}
      />
      <DeleteDialog
        idea={deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
      />
    </div>
  );
}

// ─── Card with free-form drag ────────────────────────────────────

function CanvasCard({
  idea,
  active,
  pendingStatus,
  onActiveChange,
  onPositionLocal,
  onPositionCommit,
  onCycleStatus,
  onEdit,
  onDelete,
}: {
  idea: Idea;
  active: boolean;
  pendingStatus: boolean;
  onActiveChange: (active: boolean) => void;
  onPositionLocal: (x: number, y: number) => void;
  onPositionCommit: (
    x: number,
    y: number,
    original: { x: number; y: number },
  ) => void;
  onCycleStatus: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  // Drag-specific transient state lives in a ref so pointer events
  // don't cause re-renders on every move. The rendered position comes
  // from idea.positionX/Y which the parent keeps in sync via
  // onPositionLocal.
  const dragRef = React.useRef<{
    startClientX: number;
    startClientY: number;
    startCardX: number;
    startCardY: number;
    moved: boolean;
  } | null>(null);

  const s = STATUS_STYLES[idea.status];
  const StatusIcon = s.Icon;

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    // Left button only. Middle / right click should not start a drag
    // so context menus + scroll wheels still work.
    if (e.button !== 0) return;

    // Interactive descendants (status chip, edit, delete) handle their
    // own clicks — if the press originated on one of those we don't
    // hijack it as a drag.
    const target = e.target as HTMLElement;
    if (target.closest("[data-no-drag]")) return;

    e.preventDefault();
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    dragRef.current = {
      startClientX: e.clientX,
      startClientY: e.clientY,
      startCardX: idea.positionX,
      startCardY: idea.positionY,
      moved: false,
    };
    onActiveChange(true);
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.startClientX;
    const dy = e.clientY - drag.startClientY;

    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) {
      // Below threshold — treat as a still click, don't update.
      return;
    }
    drag.moved = true;

    const nextX = Math.max(
      0,
      Math.min(CANVAS_WIDTH - CARD_WIDTH, drag.startCardX + dx),
    );
    const nextY = Math.max(
      0,
      Math.min(CANVAS_HEIGHT - CARD_HEIGHT, drag.startCardY + dy),
    );
    onPositionLocal(nextX, nextY);
  }

  function endDrag(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    try {
      (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
    } catch {
      // Pointer was already released (e.g. pointercancel) — ignore.
    }
    onActiveChange(false);

    if (drag.moved) {
      onPositionCommit(idea.positionX, idea.positionY, {
        x: drag.startCardX,
        y: drag.startCardY,
      });
    }
  }

  return (
    <div
      data-idea-id={idea.id}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      className={cn(
        "group absolute rounded-xl border bg-card shadow-sm",
        "transition-shadow",
        s.border,
        s.glow,
        active && "z-20 ring-2 ring-primary/50",
      )}
      style={{
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        transform: `translate3d(${idea.positionX}px, ${idea.positionY}px, 0)`,
        // Disable native touch gestures on the card so pointer-drag
        // works cleanly on mobile without the page trying to scroll.
        touchAction: "none",
        cursor: active ? "grabbing" : "grab",
      }}
    >
      <div className="flex h-full flex-col gap-2 p-4">
        {/* Top row: hover-revealed edit + delete */}
        <div className="flex items-start justify-between gap-2">
          <h3 className="line-clamp-2 flex-1 text-sm font-semibold leading-snug text-foreground">
            {idea.title}
          </h3>
          <div
            className={cn(
              "flex shrink-0 items-center gap-0.5",
              "opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100",
            )}
            data-no-drag
          >
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-6"
              onClick={onEdit}
              aria-label="Edit idea"
              data-no-drag
            >
              <Pencil className="size-3" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-6 text-rose-500 hover:bg-rose-500/10 hover:text-rose-500"
              onClick={onDelete}
              aria-label="Delete idea"
              data-no-drag
            >
              <Trash2 className="size-3" />
            </Button>
          </div>
        </div>

        {idea.description && (
          <p className="line-clamp-3 text-xs leading-snug text-muted-foreground">
            {idea.description}
          </p>
        )}

        {/* Bottom row: status chip (click to cycle) + author */}
        <div className="mt-auto flex items-center justify-between">
          <button
            type="button"
            data-no-drag
            onClick={onCycleStatus}
            disabled={pendingStatus}
            aria-label={`Cycle status (currently ${s.label})`}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider transition-colors",
              s.chip,
              s.chipHover,
              pendingStatus && "opacity-50",
            )}
          >
            <StatusIcon className="size-3.5" />
            {s.label}
          </button>
          <span className="truncate text-[10px] text-muted-foreground/70">
            {idea.createdBy?.username ?? "—"}
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── Empty state ─────────────────────────────────────────────────

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <div className="pointer-events-auto flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-card/80 px-8 py-12 text-center shadow-sm backdrop-blur-sm">
        <div className="flex size-12 items-center justify-center rounded-full bg-primary/10">
          <Lightbulb className="size-5 text-primary" />
        </div>
        <div>
          <p className="text-sm font-medium">No ideas yet</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Drag cards anywhere on the canvas. Click a chip to cycle neutral →
            go → kill.
          </p>
        </div>
        <Button size="sm" onClick={onNew}>
          <Plus className="size-4" />
          New idea
        </Button>
      </div>
    </div>
  );
}

// ─── Create dialog ───────────────────────────────────────────────

function CreateDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (!open) {
      setTitle("");
      setDescription("");
    }
  }, [open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    const result = await createIdea({
      title: title.trim(),
      description: description.trim() || undefined,
    });
    setSaving(false);
    if (!result.success) {
      toast.error(result.error);
      return;
    }
    toast.success("Idea added");
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>New idea</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                Title
              </label>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="What's the idea?"
                maxLength={140}
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                Description
                <span className="ml-1 font-normal text-muted-foreground/60">
                  (optional)
                </span>
              </label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Any context, links, or details…"
                rows={4}
                maxLength={2000}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!title.trim() || saving}>
              {saving ? "Adding…" : "Add idea"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Edit dialog ─────────────────────────────────────────────────

function EditDialog({
  idea,
  onOpenChange,
}: {
  idea: Idea | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (idea) {
      setTitle(idea.title);
      setDescription(idea.description ?? "");
    }
  }, [idea]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!idea || !title.trim()) return;
    setSaving(true);
    const result = await updateIdea({
      id: idea.id,
      title: title.trim(),
      description: description.trim() ? description.trim() : null,
    });
    setSaving(false);
    if (!result.success) {
      toast.error(result.error);
      return;
    }
    toast.success("Idea updated");
    onOpenChange(false);
  }

  return (
    <Dialog open={idea !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Edit idea</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                Title
              </label>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={140}
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                Description
              </label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={4}
                maxLength={2000}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!title.trim() || saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Delete dialog ───────────────────────────────────────────────

function DeleteDialog({
  idea,
  onOpenChange,
}: {
  idea: Idea | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [deleting, setDeleting] = React.useState(false);

  async function handleDelete() {
    if (!idea) return;
    setDeleting(true);
    const result = await deleteIdea(idea.id);
    setDeleting(false);
    if (!result.success) {
      toast.error(result.error);
      return;
    }
    toast.success("Idea deleted");
    onOpenChange(false);
  }

  return (
    <AlertDialog open={idea !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete idea?</AlertDialogTitle>
          <AlertDialogDescription>
            {idea ? (
              <>
                &ldquo;<span className="font-medium">{idea.title}</span>&rdquo;
                will be permanently removed.
              </>
            ) : (
              "This cannot be undone."
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleDelete}
            disabled={deleting}
            className="bg-rose-500 text-white hover:bg-rose-500/90"
          >
            {deleting ? "Deleting…" : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
