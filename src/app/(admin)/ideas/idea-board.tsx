"use client";

import * as React from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  rectSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  GripVertical,
  Plus,
  Trash2,
  Pencil,
  Lightbulb,
  Circle,
  CheckCircle2,
  XCircle,
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
  reorderIdeas,
  setIdeaStatus,
  updateIdea,
} from "./actions";
import { NEXT_STATUS, type Idea, type IdeaStatus } from "./types";

// ─── Status → style mapping ──────────────────────────────────────
//
// House-POV note: these colors are a user-intent signal for the idea
// (green = "yes, do it" / red = "kill it"), not a financial direction,
// so the usual house-perspective flip doesn't apply. Green stays green.

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
    border: "border-emerald-500/50",
    glow: "shadow-[0_0_24px_-8px_rgba(16,185,129,0.55)]",
    chip: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 ring-1 ring-emerald-500/40",
    chipHover: "hover:bg-emerald-500/25",
    label: "Go",
    Icon: CheckCircle2,
  },
  red: {
    border: "border-rose-500/50",
    glow: "shadow-[0_0_24px_-8px_rgba(244,63,94,0.55)]",
    chip: "bg-rose-500/15 text-rose-600 dark:text-rose-400 ring-1 ring-rose-500/40",
    chipHover: "hover:bg-rose-500/25",
    label: "Kill",
    Icon: XCircle,
  },
};

// ─── Board ───────────────────────────────────────────────────────

export function IdeaBoard({ initial }: { initial: Idea[] }) {
  const [ideas, setIdeas] = React.useState<Idea[]>(initial);
  // Track the last server-saved order so we can roll back on error.
  const lastSavedRef = React.useRef<Idea[]>(initial);
  // Pending status flips are applied optimistically so a click feels
  // instant; a server failure reverts the card without a full refresh.
  const [pendingId, setPendingId] = React.useState<string | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Idea | null>(null);
  const [deleting, setDeleting] = React.useState<Idea | null>(null);

  // Keep local state in sync if the server-loaded initial prop changes
  // (router.refresh on another tab, etc).
  React.useEffect(() => {
    setIdeas(initial);
    lastSavedRef.current = initial;
  }, [initial]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      // Require a small drag distance so the pointerdown that starts a
      // status-toggle click isn't misinterpreted as a drag.
      activationConstraint: { distance: 6 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const ids = React.useMemo(() => ideas.map((i) => i.id), [ideas]);

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const from = ideas.findIndex((i) => i.id === active.id);
    const to = ideas.findIndex((i) => i.id === over.id);
    if (from === -1 || to === -1) return;

    const next = arrayMove(ideas, from, to);
    setIdeas(next);

    const result = await reorderIdeas(next.map((i) => i.id));
    if (!result.success) {
      toast.error(result.error);
      setIdeas(lastSavedRef.current);
      return;
    }
    lastSavedRef.current = next;
  }

  async function handleCycleStatus(idea: Idea) {
    const target = NEXT_STATUS[idea.status];
    const prev = ideas;
    setPendingId(idea.id);
    setIdeas((list) =>
      list.map((i) => (i.id === idea.id ? { ...i, status: target } : i)),
    );
    const result = await setIdeaStatus({ id: idea.id, status: target });
    setPendingId(null);
    if (!result.success) {
      toast.error(result.error);
      setIdeas(prev);
    } else {
      lastSavedRef.current = lastSavedRef.current.map((i) =>
        i.id === idea.id ? { ...i, status: target } : i,
      );
    }
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>
            {ideas.length} idea{ideas.length === 1 ? "" : "s"} ·{" "}
            {ideas.filter((i) => i.status === "green").length} go ·{" "}
            {ideas.filter((i) => i.status === "red").length} kill
          </span>
        </div>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="size-4" />
          New idea
        </Button>
      </div>

      {/* Board */}
      {ideas.length === 0 ? (
        <EmptyState onNew={() => setCreateOpen(true)} />
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={ids} strategy={rectSortingStrategy}>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {ideas.map((idea) => (
                <SortableCard
                  key={idea.id}
                  idea={idea}
                  pending={pendingId === idea.id}
                  onCycle={() => handleCycleStatus(idea)}
                  onEdit={() => setEditing(idea)}
                  onDelete={() => setDeleting(idea)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

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

// ─── Sortable card ───────────────────────────────────────────────

function SortableCard({
  idea,
  pending,
  onCycle,
  onEdit,
  onDelete,
}: {
  idea: Idea;
  pending: boolean;
  onCycle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: idea.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const s = STATUS_STYLES[idea.status];
  const StatusIcon = s.Icon;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "group relative flex flex-col gap-3 rounded-xl border bg-card p-4 transition-shadow",
        s.border,
        s.glow,
        isDragging && "z-10 opacity-60 ring-2 ring-primary/40",
      )}
    >
      {/* Drag handle + row actions */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          aria-label="Drag to reorder"
          className="-ml-1 rounded-md p-1 text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
          style={{ cursor: "grab" }}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-4" />
        </button>
        <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={onEdit}
            aria-label="Edit idea"
          >
            <Pencil className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 text-rose-500 hover:bg-rose-500/10 hover:text-rose-500"
            onClick={onDelete}
            aria-label="Delete idea"
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* Title + description */}
      <div className="space-y-1.5">
        <h3 className="line-clamp-2 text-sm font-semibold leading-snug text-foreground">
          {idea.title}
        </h3>
        {idea.description && (
          <p className="line-clamp-4 text-xs text-muted-foreground">
            {idea.description}
          </p>
        )}
      </div>

      {/* Status chip — click cycles neutral → green → red → neutral */}
      <div className="mt-auto flex items-center justify-between pt-1">
        <button
          type="button"
          onClick={onCycle}
          disabled={pending}
          aria-label={`Cycle status (currently ${s.label})`}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider transition-colors",
            s.chip,
            s.chipHover,
            pending && "opacity-50",
          )}
        >
          <StatusIcon className="size-3.5" />
          {s.label}
        </button>
        <span className="text-[10px] text-muted-foreground/80">
          {idea.createdBy?.username ?? "—"}
        </span>
      </div>
    </div>
  );
}

// ─── Empty state ─────────────────────────────────────────────────

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-card/50 px-6 py-16 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-primary/10">
        <Lightbulb className="size-5 text-primary" />
      </div>
      <div>
        <p className="text-sm font-medium">No ideas yet</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Capture a thought — drag to reorder, click the chip to mark go or kill.
        </p>
      </div>
      <Button size="sm" onClick={onNew}>
        <Plus className="size-4" />
        New idea
      </Button>
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

  // Reset fields whenever the dialog closes so the next open starts clean.
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

  // Snap fields to the incoming idea when the dialog opens.
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
